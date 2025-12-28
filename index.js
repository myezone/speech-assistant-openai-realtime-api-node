/**
 * index.js — Twilio Media Streams ↔ OpenAI Realtime (voice↔voice)
 * + Vector Store kb_search tool
 * + Call logging to Postgres:
 *    - calls (start, summary, duration fallback)
 *    - call_utterances (turn-by-turn transcripts)
 *
 * REQUIRED env vars:
 *  - OPENAI_API_KEY
 *  - OPENAI_PROMPT_ID
 *  - VECTOR_STORE_ID
 *
 * OPTIONAL:
 *  - PORT (default 10000)
 *  - VOICE (default "marin")
 *  - OPENAI_TRANSCRIPTION_MODEL (default "whisper-1")
 *  - MAX_TRANSCRIPTS (default 50)
 *  - PUBLIC_HOST (recommended; used in TwiML Stream URL)
 */

import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

import {
  upsertCallStart,
  logUtterance,
  saveCallSummary,
  setCallDurationFallback,
  setOfficialCallDuration,
} from "./callLog.js";

dotenv.config();

const {
  OPENAI_API_KEY,
  OPENAI_PROMPT_ID,
  VECTOR_STORE_ID,
  PORT,
  VOICE,
  OPENAI_TRANSCRIPTION_MODEL,
  MAX_TRANSCRIPTS,
  PUBLIC_HOST,
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in environment variables.");
  process.exit(1);
}
if (!OPENAI_PROMPT_ID) {
  console.error("Missing OPENAI_PROMPT_ID in environment variables.");
  process.exit(1);
}
if (!VECTOR_STORE_ID) {
  console.error("Missing VECTOR_STORE_ID in environment variables.");
  process.exit(1);
}

const fastify = Fastify({ logger: true });

await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

const LISTEN_PORT = Number(PORT) || 10000;

// NOTE: keep your current model string as-is (you already have it working)
const REALTIME_MODEL = "gpt-realtime";

const DEFAULT_VOICE = VOICE || "marin";
const TRANSCRIPTION_MODEL = OPENAI_TRANSCRIPTION_MODEL || "whisper-1";
const RETAIN_MAX = Math.max(1, Math.min(500, Number(MAX_TRANSCRIPTS) || 50));

// Twilio Media Streams audio is 8kHz μ-law (pcmu).
// μ-law 8k = 8000 bytes/sec ≈ 8 bytes/ms
const PCMU_BYTES_PER_MS = 8;
const OUT_CHUNK_MS = 20;
const OUT_CHUNK_BYTES = OUT_CHUNK_MS * PCMU_BYTES_PER_MS; // 160 bytes
const ASSISTANT_AUDIO_IDLE_MS = 250;

// -----------------------------
// In-memory transcript store
// -----------------------------
const transcriptsByStreamSid = new Map(); // streamSid -> record
const transcriptOrder = []; // oldest -> newest
let latestStreamSid = null;

function retainIfNeeded() {
  while (transcriptOrder.length > RETAIN_MAX) {
    const sid = transcriptOrder.shift();
    if (sid) transcriptsByStreamSid.delete(sid);
  }
}

function getOrCreateTranscript(streamSid) {
  if (!streamSid) return null;
  let rec = transcriptsByStreamSid.get(streamSid);
  if (!rec) {
    rec = {
      streamSid,
      callSid: null, // Twilio CallSid (CA...)
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      turns: [], // { role: 'user'|'assistant', text, ts }
      summarySaved: false,
    };
    transcriptsByStreamSid.set(streamSid, rec);
    transcriptOrder.push(streamSid);
    latestStreamSid = streamSid;
    retainIfNeeded();
  }
  return rec;
}

function b64ToBuf(b64) {
  try {
    return Buffer.from(b64, "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

function bufToB64(buf) {
  return buf.toString("base64");
}

/**
 * Persist one turn to DB (non-blocking).
 * IMPORTANT: uses Twilio CallSid (CA...) which we store on rec.callSid.
 */
function persistTurn(rec, role, text) {
  const callSid = rec?.callSid;
  if (!callSid) return;

  const dbRole = role === "user" ? "caller" : "agent";
  void logUtterance({ callId: callSid, role: dbRole, text }).catch((e) => {
    fastify.log.error({ callSid, err: String(e) }, "logUtterance failed");
  });
}

function addTurn(streamSid, role, text) {
  const rec = getOrCreateTranscript(streamSid);
  if (!rec) return;

  const clean = (text || "").trim();
  if (!clean) return;

  const now = Date.now();
  const last = rec.turns.length ? rec.turns[rec.turns.length - 1] : null;

  // Merge short fragments if same role within 1.2s
  if (last && last.role === role && now - last.ts <= 1200) {
    if (last.text.length < 40 || clean.length < 40) {
      last.text = `${last.text} ${clean}`.trim();
      last.ts = now;
    } else {
      rec.turns.push({ role, text: clean, ts: now });
    }
  } else {
    rec.turns.push({ role, text: clean, ts: now });
  }

  if (role === "user") fastify.log.info({ streamSid, user: clean }, "USER TRANSCRIPT");
  if (role === "assistant") fastify.log.info({ streamSid, assistant: clean }, "ASSISTANT TRANSCRIPT");

  // ✅ NEW: write to Postgres (turn-by-turn) without blocking audio
  persistTurn(rec, role, clean);
}

/**
 * Save summary + fallback duration once at end of call.
 * Safe to call multiple times (it will only save once).
 */
function finalizeCallIfPossible(streamSid, fallbackCallSid = null) {
  const rec = streamSid ? transcriptsByStreamSid.get(streamSid) : null;
  if (!rec) return;

  if (!rec.endedAt) {
    rec.endedAt = Date.now();
    rec.durationMs = rec.endedAt - rec.startedAt;
  }

  rec.callSid = rec.callSid || fallbackCallSid || null;
  const callSid = rec.callSid;

  if (!callSid || rec.summarySaved) return;

  rec.summarySaved = true;

  const turns = rec.turns?.length || 0;
  const durationSeconds = Math.max(0, Math.round((rec.durationMs || 0) / 1000));

  // Log the summary (your existing log line)
  fastify.log.info({ streamSid, callSid, durationMs: rec.durationMs, turns }, "CALL TRANSCRIPT SUMMARY");

  // ✅ Persist fallback duration + summary in DB (non-blocking)
  void setCallDurationFallback({ callId: callSid, durationSeconds }).catch((e) => {
    fastify.log.error({ callSid, err: String(e) }, "setCallDurationFallback failed");
  });

  void saveCallSummary({
    callId: callSid,
    summaryText: `Call ended. Turns: ${turns}. Stream duration: ${durationSeconds}s.`,
    summaryJson: { turns, durationMs: rec.durationMs, durationSeconds },
  }).catch((e) => {
    fastify.log.error({ callSid, err: String(e) }, "saveCallSummary failed");
  });
}

// -----------------------------
// Basic routes
// -----------------------------
fastify.get("/", async (_req, reply) => reply.send({ ok: true, service: "Voice IVA" }));

fastify.get("/transcripts/latest", async (_req, reply) => {
  if (!latestStreamSid) return reply.code(404).send({ error: "No transcripts yet." });
  const rec = transcriptsByStreamSid.get(latestStreamSid);
  if (!rec) return reply.code(404).send({ error: "No transcripts yet." });
  return reply.send(rec);
});

fastify.get("/transcripts", async (_req, reply) => {
  const list = transcriptOrder
    .slice()
    .reverse()
    .map((sid) => transcriptsByStreamSid.get(sid))
    .filter(Boolean);
  return reply.send({ count: list.length, items: list });
});

fastify.get("/transcripts/:streamSid", async (req, reply) => {
  const { streamSid } = req.params;
  const rec = transcriptsByStreamSid.get(streamSid);
  if (!rec) return reply.code(404).send({ error: "Not found." });
  return reply.send(rec);
});

fastify.get("/kb-status", async (_req, reply) => {
  try {
    const resp = await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
      },
    });
    const json = await resp.json();
    reply.code(resp.status).send(json);
  } catch (e) {
    reply.code(500).send({ error: String(e) });
  }
});

// -----------------------------
// Twilio webhook: incoming call -> TwiML Stream
// -----------------------------
fastify.all("/incoming-call", async (request, reply) => {
  const callId = request.body?.CallSid || request.query?.CallSid || null;
  const from = request.body?.From || request.query?.From || null;
  const to = request.body?.To || request.query?.To || null;

  try {
    fastify.log.info({ callId, from, to }, "✅ /incoming-call HIT");

    if (callId) {
      await upsertCallStart({ callId, from, to });
      fastify.log.info({ callId }, "✅ DB INSERT OK (call start)");
    } else {
      fastify.log.warn({ body: request.body, query: request.query }, "⚠️ No CallSid found on /incoming-call");
    }
  } catch (err) {
    fastify.log.error({ err: String(err), callId }, "❌ DB INSERT FAILED (call start)");
  }

  const host = PUBLIC_HOST || request.headers["x-forwarded-host"] || request.headers.host;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;

  reply.code(200).type("text/xml").send(twiml);
});

// -----------------------------
// Twilio Status Callback (official duration on completed)
// -----------------------------
fastify.post("/twilio/call-status", async (req, reply) => {
  try {
    const callId = req.body?.CallSid;
    const callStatus = req.body?.CallStatus;
    const callDuration = Number(req.body?.CallDuration || 0);

    if (callStatus === "completed") {
      await setOfficialCallDuration({
        callId,
        durationSeconds: callDuration,
        status: callStatus,
      });
      fastify.log.info({ callId, callDuration }, "✅ Official duration saved (Twilio completed)");
    }
  } catch (err) {
    fastify.log.error({ err: String(err) }, "❌ /twilio/call-status failed");
  }

  return reply.code(200).send("ok");
});

// -----------------------------
// Vector store search helpers
// -----------------------------
async function vectorStoreSearch(query) {
  const resp = await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({ query, max_num_results: 5 }),
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`Vector store search failed: ${resp.status} ${JSON.stringify(json)}`);
  return json;
}

function extractPassages(vsJson) {
  const rows = Array.isArray(vsJson?.data) ? vsJson.data : [];
  const passages = rows
    .slice(0, 5)
    .map((r) => {
      const contentArr = Array.isArray(r?.content) ? r.content : [];
      const text = contentArr
        .map((c) => {
          const t = c?.text;
          if (typeof t === "string") return t;
          if (t && typeof t === "object" && typeof t.value === "string") return t.value;
          return "";
        })
        .filter(Boolean)
        .join("\n\n")
        .trim();
      return text;
    })
    .filter(Boolean);

  return passages.join("\n---\n");
}

// -----------------------------
// Media Stream (WebSocket): Twilio ↔ OpenAI Realtime
// -----------------------------
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection) => {
    fastify.log.info("Client connected (Twilio WS)");

    // Twilio state
    let streamSid = null;
    let callSid = null;
    let latestMediaTimestamp = 0;

    // OpenAI session state
    let sessionReady = false;
    let streamReady = false;
    let greeted = false;

    // IMPORTANT: separate "requested" from "in flight"
    let responseRequested = false;
    let responseInFlight = false;
    let queuedResponseCreate = false;
    let activeResponseId = null;

    // Tool dedupe
    const handledToolCalls = new Set();

    // Transcript buffers
    const userTranscriptBufferByItem = new Map();
    const assistantTranscriptBufferByResp = new Map();

    // Outbound audio pacing queue
    let outQueue = [];
    let outQueueBytes = 0;
    let outPacer = null;

    // "assistant speaking" based on *actual audio output activity*
    let lastAssistantAudioAt = 0;

    const resetOutQueue = () => {
      outQueue = [];
      outQueueBytes = 0;
    };

    const pullBytes = (n) => {
      let remaining = n;
      const parts = [];

      while (remaining > 0 && outQueue.length > 0) {
        const head = outQueue[0].buf;
        if (head.length <= remaining) {
          parts.push(head);
          remaining -= head.length;
          outQueue.shift();
        } else {
          parts.push(head.subarray(0, remaining));
          outQueue[0].buf = head.subarray(remaining);
          remaining = 0;
        }
      }

      const chunk = Buffer.concat(parts);
      outQueueBytes -= chunk.length;
      if (outQueueBytes < 0) outQueueBytes = 0;
      return chunk;
    };

    const sendTwilioAudioChunk = (chunkBuf) => {
      if (!streamSid || chunkBuf.length === 0) return;
      connection.send(JSON.stringify({ event: "media", streamSid, media: { payload: bufToB64(chunkBuf) } }));
      lastAssistantAudioAt = Date.now();
    };

    const stopPacer = () => {
      if (outPacer) clearInterval(outPacer);
      outPacer = null;
    };

    const startPacer = () => {
      if (outPacer) return;
      outPacer = setInterval(() => {
        if (outQueueBytes >= OUT_CHUNK_BYTES) {
          sendTwilioAudioChunk(pullBytes(OUT_CHUNK_BYTES));
        } else {
          const idle = Date.now() - lastAssistantAudioAt;
          if (outQueueBytes === 0 && idle > 500) stopPacer();
        }
      }, OUT_CHUNK_MS);
    };

    const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });

    const safeSendOpenAI = (obj) => {
      if (openAiWs.readyState !== WebSocket.OPEN) return false;
      openAiWs.send(JSON.stringify(obj));
      return true;
    };

    const requestResponseCreate = (reason = "") => {
      if (responseRequested || responseInFlight) {
        queuedResponseCreate = true;
        return;
      }
      responseRequested = true;
      safeSendOpenAI({ type: "response.create" });
      if (reason) fastify.log.info({ reason, streamSid }, "Sent response.create");
    };

    const maybeGreet = () => {
      if (greeted) return;
      if (!sessionReady || !streamReady) return;
      greeted = true;
      requestResponseCreate("initial_greeting");
    };

    const initializeSession = () => {
      safeSendOpenAI({
        type: "session.update",
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcmu" },
              turn_detection: { type: "server_vad" },
              transcription: { model: TRANSCRIPTION_MODEL },
            },
            output: { format: { type: "audio/pcmu" }, voice: DEFAULT_VOICE },
          },
          prompt: { id: OPENAI_PROMPT_ID },
          tools: [
            {
              type: "function",
              name: "kb_search",
              description: "Search the CallsAnswered.ai knowledge base and return relevant passages.",
              parameters: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          ],
          tool_choice: "auto",
        },
      });
    };

    const assistantIsActuallyPlayingAudio = () => {
      const idle = Date.now() - lastAssistantAudioAt;
      return outQueueBytes > 0 || idle < ASSISTANT_AUDIO_IDLE_MS;
    };

    const handleBargeIn = () => {
      if (!assistantIsActuallyPlayingAudio()) return;

      // Stop Twilio playback + drop queued frames
      if (streamSid) connection.send(JSON.stringify({ event: "clear", streamSid }));
      resetOutQueue();

      if (responseInFlight) {
        safeSendOpenAI({ type: "response.cancel" });
      }

      responseRequested = false;
      responseInFlight = false;
      activeResponseId = null;
      queuedResponseCreate = false;
    };

    openAiWs.on("open", () => {
      fastify.log.info("Connected to OpenAI Realtime");
      setTimeout(initializeSession, 50);
    });

    openAiWs.on("message", async (raw) => {
      try {
        const evt = JSON.parse(raw);

        if (evt.type === "error") {
          const code = evt?.error?.code;
          if (code === "response_cancel_not_active") {
            responseRequested = false;
            responseInFlight = false;
            activeResponseId = null;
            return;
          }
          fastify.log.error({ openai_error: evt, streamSid }, "OPENAI ERROR EVENT");
          return;
        }

        if (evt.type === "session.updated") {
          sessionReady = true;
          maybeGreet();
          return;
        }

        if (evt.type === "response.created") {
          responseInFlight = true;
          responseRequested = false;
          activeResponseId = evt.response?.id || evt.response_id || null;
          return;
        }

        if (evt.type === "response.done") {
          responseInFlight = false;
          responseRequested = false;
          activeResponseId = null;

          if (queuedResponseCreate) {
            queuedResponseCreate = false;
            requestResponseCreate("queued_after_response_done");
          }
          return;
        }

        // Caller transcript
        if (evt.type === "conversation.item.input_audio_transcription.delta") {
          const itemId = evt.item_id;
          const delta = evt.delta || "";
          const prev = userTranscriptBufferByItem.get(itemId) || "";
          userTranscriptBufferByItem.set(itemId, prev + delta);
          return;
        }

        if (evt.type === "conversation.item.input_audio_transcription.completed") {
          const itemId = evt.item_id;
          const finalText = (evt.transcript || userTranscriptBufferByItem.get(itemId) || "").trim();
          userTranscriptBufferByItem.delete(itemId);
          if (finalText) addTurn(streamSid, "user", finalText);
          return;
        }

        // Assistant transcript
        if (evt.type === "response.output_audio_transcript.delta") {
          const rid = evt.response_id;
          const delta = evt.delta || "";
          const prev = assistantTranscriptBufferByResp.get(rid) || "";
          assistantTranscriptBufferByResp.set(rid, prev + delta);
          return;
        }

        if (evt.type === "response.output_audio_transcript.done") {
          const rid = evt.response_id;
          const finalText = (evt.transcript || assistantTranscriptBufferByResp.get(rid) || "").trim();
          assistantTranscriptBufferByResp.delete(rid);
          if (finalText) addTurn(streamSid, "assistant", finalText);
          return;
        }

        // Assistant audio delta -> queue + pace
        const isAudioDelta =
          (evt.type === "response.audio.delta" || evt.type === "response.output_audio.delta") &&
          typeof evt.delta === "string" &&
          evt.delta.length > 0;

        if (isAudioDelta) {
          if (!streamSid) return;

          const buf = b64ToBuf(evt.delta);
          if (buf.length > 0) {
            outQueue.push({ buf });
            outQueueBytes += buf.length;
            startPacer();
          }
          return;
        }

        // Barge-in trigger
        if (evt.type === "input_audio_buffer.speech_started") {
          handleBargeIn();
          return;
        }

        // Tool call: kb_search
        if (evt.type === "response.output_item.done" && evt.item?.type === "function_call") {
          const functionCall = evt.item;
          if (functionCall.name !== "kb_search" || !functionCall.call_id) return;

          const toolCallId = functionCall.call_id;
          if (handledToolCalls.has(toolCallId)) return;
          handledToolCalls.add(toolCallId);

          const rawArgs = functionCall.arguments ?? functionCall.arguments_json ?? "{}";
          let args = {};
          try {
            args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
          } catch {
            args = {};
          }

          const query = String(args?.query || "").trim() || "callsanswered";
          fastify.log.info({ streamSid, query, callId: toolCallId }, "kb_search tool call");

          let passages = "";
          try {
            const vsJson = await vectorStoreSearch(query);
            passages = extractPassages(vsJson);
          } catch (e) {
            fastify.log.error({ streamSid, err: String(e) }, "KB search failed");
            passages = "";
          }

          safeSendOpenAI({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: toolCallId,
              output: JSON.stringify({ query, passages }),
            },
          });

          requestResponseCreate("after_kb_search_output");
          return;
        }
      } catch (err) {
        fastify.log.error({ streamSid, err: String(err) }, "Error processing OpenAI event");
      }
    });

    openAiWs.on("close", () => fastify.log.info({ streamSid }, "Disconnected from OpenAI Realtime"));
    openAiWs.on("error", (e) => fastify.log.error({ streamSid, err: String(e) }, "OpenAI WS error"));

    // Twilio -> server
    connection.on("message", (msg) => {
      try {
        const data = JSON.parse(msg);

        switch (data.event) {
          case "start": {
            streamSid = data.start.streamSid;
            callSid = data.start.callSid || null;
            streamReady = true;

            const rec = getOrCreateTranscript(streamSid);
            if (rec) rec.callSid = callSid;

            fastify.log.info({ streamSid, callSid }, "Incoming stream started");

            latestMediaTimestamp = 0;

            responseRequested = false;
            responseInFlight = false;
            queuedResponseCreate = false;
            activeResponseId = null;

            handledToolCalls.clear();
            userTranscriptBufferByItem.clear();
            assistantTranscriptBufferByResp.clear();

            resetOutQueue();
            lastAssistantAudioAt = 0;
            stopPacer();

            greeted = false;
            maybeGreet();
            break;
          }

          case "media":
            latestMediaTimestamp = data.media.timestamp;
            if (openAiWs.readyState === WebSocket.OPEN) {
              safeSendOpenAI({ type: "input_audio_buffer.append", audio: data.media.payload });
            }
            break;

          case "stop":
            fastify.log.info({ streamSid }, "Received stop event from Twilio.");
            // ✅ persist summary as early as possible
            finalizeCallIfPossible(streamSid, callSid);
            break;

          default:
            break;
        }
      } catch (err) {
        fastify.log.error({ streamSid, err: String(err) }, "Error parsing Twilio message");
      }
    });

    connection.on("close", () => {
      fastify.log.info({ streamSid }, "Client disconnected (Twilio WS).");

      stopPacer();
      resetOutQueue();

      // ✅ ensure summary persisted even if stop was missed
      if (streamSid) finalizeCallIfPossible(streamSid, callSid);

      try {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(1000, "twilio_disconnected");
        else openAiWs.terminate();
      } catch {}
    });
  });
});

// -----------------------------
// Start server (after routes)
// -----------------------------
fastify.listen({ port: LISTEN_PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Server is listening on port ${LISTEN_PORT}`);
});
