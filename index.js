/**
 * index.js — Twilio Media Streams ↔ OpenAI Realtime (voice↔voice)
 *         + Vector Store kb_search tool
 *         + Call transcripts (caller + assistant) captured from OpenAI events
 *
 * Key fixes vs prior version:
 *  1) Cancel gating + state sync to eliminate response_cancel_not_active log spam
 *  2) Outbound audio pacing to Twilio (20ms μ-law frames) to reduce distortion/jitter
 *  3) Barge-in now uses cancel+clear (no truncate) to avoid chopping artifacts
 *
 * REQUIRED env vars:
 *  - OPENAI_API_KEY
 *  - OPENAI_PROMPT_ID
 *  - VECTOR_STORE_ID
 *
 * OPTIONAL env vars:
 *  - PORT (default 10000)
 *  - VOICE (default "marin")
 *  - OPENAI_TRANSCRIPTION_MODEL (default "whisper-1")
 *  - MAX_TRANSCRIPTS (default 50)
 *  - PUBLIC_HOST (recommended) e.g. your-service.onrender.com (used for TwiML Stream URL)
 */

import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

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
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const LISTEN_PORT = Number(PORT) || 10000;
const REALTIME_MODEL = "gpt-realtime";
const DEFAULT_VOICE = VOICE || "marin";
const TRANSCRIPTION_MODEL = OPENAI_TRANSCRIPTION_MODEL || "whisper-1";
const RETAIN_MAX = Math.max(1, Math.min(500, Number(MAX_TRANSCRIPTS) || 50));

// Twilio Media Streams is 8kHz μ-law (pcmu).
// μ-law 8k = 8000 bytes/sec ≈ 8 bytes/ms
const PCMU_BYTES_PER_MS = 8;
const OUT_CHUNK_MS = 20;
const OUT_CHUNK_BYTES = OUT_CHUNK_MS * PCMU_BYTES_PER_MS; // 160 bytes

// In-memory transcript store (resets on deploy/restart)
const transcriptsByStreamSid = new Map(); // streamSid -> record
const transcriptOrder = []; // oldest -> newest (streamSid)
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
      callSid: null,
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      turns: [], // { role: 'user'|'assistant', text, ts }
    };
    transcriptsByStreamSid.set(streamSid, rec);
    transcriptOrder.push(streamSid);
    latestStreamSid = streamSid;
    retainIfNeeded();
  }
  return rec;
}

function addTurn(streamSid, role, text) {
  const rec = getOrCreateTranscript(streamSid);
  if (!rec) return;
  const clean = (text || "").trim();
  if (!clean) return;

  const now = Date.now();
  const last = rec.turns.length ? rec.turns[rec.turns.length - 1] : null;

  // merge small fragments if same role within 1.2s
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
}

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

// Twilio webhook: start Media Stream
fastify.all("/incoming-call", async (request, reply) => {
  // Prefer a stable, explicit hostname for Twilio <Stream> URL.
  // If you set PUBLIC_HOST in Render env vars, we use it.
  // Otherwise we fall back to forwarded host headers.
  const host =
    PUBLIC_HOST ||
    request.headers["x-forwarded-host"] ||
    request.headers.host;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;

  reply.code(200).type("text/xml").send(twiml);
});

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

// Helpers for paced audio queue (avoid concat in hot path)
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

fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection) => {
    fastify.log.info("Client connected (Twilio WS)");

    // Twilio state
    let streamSid = null;
    let callSid = null;
    let latestMediaTimestamp = 0;

    // OpenAI state
    let sessionReady = false;
    let streamReady = false;
    let greeted = false;

    // Response concurrency state
    let responseInFlight = false;
    let queuedResponseCreate = false;
    let activeResponseId = null;

    // Speaking / barge-in
    let assistantSpeaking = false;

    // Tool dedupe
    const handledToolCalls = new Set();

    // Transcript buffers
    const userTranscriptBufferByItem = new Map();       // item_id -> text
    const assistantTranscriptBufferByResp = new Map();  // response_id -> text

    // Outbound paced audio queue (Twilio)
    let outQueue = [];          // array of { buf: Buffer }
    let outQueueBytes = 0;      // total queued bytes
    let outPacer = null;        // interval id

    const resetOutQueue = () => {
      outQueue = [];
      outQueueBytes = 0;
    };

    // Pull exactly n bytes from outQueue (assumes outQueueBytes >= n)
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

      const chunk = Buffer.concat(parts, n - remaining);
      outQueueBytes -= chunk.length;
      if (outQueueBytes < 0) outQueueBytes = 0;
      return chunk;
    };

    const sendTwilioAudioChunk = (chunkBuf) => {
      if (!streamSid || chunkBuf.length === 0) return;
      connection.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: bufToB64(chunkBuf) },
        })
      );
    };

    const startPacer = () => {
      if (outPacer) return;
      outPacer = setInterval(() => {
        try {
          // Send one 20ms frame per tick if available.
          if (!streamSid) return;
          if (outQueueBytes >= OUT_CHUNK_BYTES) {
            const chunk = pullBytes(OUT_CHUNK_BYTES);
            sendTwilioAudioChunk(chunk);
          }
        } catch (e) {
          fastify.log.error({ streamSid, err: String(e) }, "Outbound pacer error");
        }
      }, OUT_CHUNK_MS);
    };

    const stopPacer = () => {
      if (outPacer) clearInterval(outPacer);
      outPacer = null;
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
      if (responseInFlight) {
        queuedResponseCreate = true;
        return;
      }
      responseInFlight = true;
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
            output: {
              format: { type: "audio/pcmu" },
              voice: DEFAULT_VOICE,
            },
          },

          // Greeting + behavior defined in your saved prompt
          prompt: { id: OPENAI_PROMPT_ID },

          // KB tool (server executes Vector Store search)
          tools: [
            {
              type: "function",
              name: "kb_search",
              description:
                "Search the CallsAnswered.ai knowledge base and return relevant passages. Use this before answering factual questions.",
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

    const handleBargeIn = () => {
      // Only act if the assistant is actually speaking or a response is active.
      if (!assistantSpeaking && !responseInFlight) return;

      // Cancel only when we believe a response is active (avoid cancel_not_active spam).
      if (responseInFlight) {
        safeSendOpenAI({ type: "response.cancel" });
      }

      // Clear Twilio playback and drop queued audio so caller doesn't hear leftover frames.
      if (streamSid) connection.send(JSON.stringify({ event: "clear", streamSid }));
      resetOutQueue();

      // Reset local flags
      assistantSpeaking = false;
      responseInFlight = false;
      queuedResponseCreate = false;
      activeResponseId = null;
    };

    openAiWs.on("open", () => {
      fastify.log.info("Connected to OpenAI Realtime");
      setTimeout(initializeSession, 50);
    });

    openAiWs.on("message", async (raw) => {
      try {
        const evt = JSON.parse(raw);

        // ---- Error handling: resync state for cancel-not-active ----
        if (evt.type === "error") {
          const code = evt?.error?.code;
          fastify.log.error({ openai_error: evt, streamSid }, "OPENAI ERROR EVENT");

          // If OpenAI says "no active response", our local state was stale (race).
          if (code === "response_cancel_not_active") {
            responseInFlight = false;
            activeResponseId = null;
          }
          return;
        }

        if (evt.type === "session.updated") {
          sessionReady = true;
          maybeGreet();
          return;
        }

        if (evt.type === "response.created") {
          responseInFlight = true;
          activeResponseId = evt.response?.id || evt.response_id || null;
          return;
        }

        if (evt.type === "response.done") {
          responseInFlight = false;
          activeResponseId = null;
          assistantSpeaking = false;

          // If we queued a create while one was in flight, fire it now.
          if (queuedResponseCreate) {
            queuedResponseCreate = false;
            requestResponseCreate("queued_after_response_done");
          }
          return;
        }

        // ---- Caller transcript ----
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

        // ---- Assistant transcript ----
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

        // ---- Assistant audio: queue and pace to Twilio ----
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
          }

          assistantSpeaking = true;
          startPacer();
          return;
        }

        // ---- Barge-in trigger ----
        if (evt.type === "input_audio_buffer.speech_started") {
          handleBargeIn();
          return;
        }

        // ---- Tool call: kb_search (ONLY handle from response.output_item.done) ----
        if (evt.type === "response.output_item.done" && evt.item?.type === "function_call") {
          const functionCall = evt.item;
          if (functionCall.name !== "kb_search" || !functionCall.call_id) return;

          const callId = functionCall.call_id;
          if (handledToolCalls.has(callId)) return;
          handledToolCalls.add(callId);

          const rawArgs = functionCall.arguments ?? functionCall.arguments_json ?? "{}";
          let args = {};
          try {
            args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
          } catch {
            args = {};
          }

          const query = String(args?.query || "").trim() || "callsanswered";
          fastify.log.info({ streamSid, query, callId }, "kb_search tool call");

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
              call_id: callId,
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

            // reset per-call state
            latestMediaTimestamp = 0;

            sessionReady = sessionReady; // keep
            greeted = false;

            responseInFlight = false;
            queuedResponseCreate = false;
            activeResponseId = null;

            assistantSpeaking = false;

            handledToolCalls.clear();
            userTranscriptBufferByItem.clear();
            assistantTranscriptBufferByResp.clear();

            resetOutQueue();
            startPacer();

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

      if (streamSid) {
        const rec = transcriptsByStreamSid.get(streamSid);
        if (rec) {
          rec.endedAt = Date.now();
          rec.durationMs = rec.endedAt - rec.startedAt;
          rec.callSid = rec.callSid || callSid || null;
          fastify.log.info(
            { streamSid, callSid: rec.callSid, durationMs: rec.durationMs, turns: rec.turns.length },
            "CALL TRANSCRIPT SUMMARY"
          );
        }
      }

      try {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(1000, "twilio_disconnected");
        else openAiWs.terminate();
      } catch {}
    });
  });
});

fastify.listen({ port: LISTEN_PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Server is listening on port ${LISTEN_PORT}`);
});
