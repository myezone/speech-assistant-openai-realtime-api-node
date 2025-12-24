/**
 * index.js — Twilio Media Streams ↔ OpenAI Realtime (voice↔voice)
 * + Vector Store kb_search tool
 * + Call transcripts (caller + assistant)
 *
 * Fixes:
 *  - Prevent response_cancel_not_active by separating "requested" vs "in-flight"
 *  - Barge-in only when assistant audio is actually being played
 *  - Pace outbound audio to Twilio in 20ms μ-law frames (reduces distortion/jitter)
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

// Twilio Media Streams audio is 8kHz μ-law (pcmu).
// μ-law 8k = 8000 bytes/sec ≈ 8 bytes/ms
const PCMU_BYTES_PER_MS = 8;
const OUT_CHUNK_MS = 20;
const OUT_CHUNK_BYTES = OUT_CHUNK_MS * PCMU_BYTES_PER_MS; // 160 bytes
const ASSISTANT_AUDIO_IDLE_MS = 250; // when no audio sent for this long, consider assistant not speaking

// In-memory transcript store
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

// Twilio webhook
fastify.all("/incoming-call", async (request, reply) => {
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

function b64ToBuf(b64) {
  try { return Buffer.from(b64, "base64"); } catch { return Buffer.alloc(0); }
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

    // OpenAI session state
    let sessionReady = false;
    let streamReady = false;
    let greeted = false;

    // IMPORTANT: separate "requested" from "in flight"
    let responseRequested = false;  // we sent response.create, waiting for response.created
    let responseInFlight = false;   // we received response.created => cancel is valid
    let queuedResponseCreate = false;
    let activeResponseId = null;

    // Tool dedupe
    const handledToolCalls = new Set();

    // Transcript buffers
    const userTranscriptBufferByItem = new Map();
    const assistantTranscriptBufferByResp = new Map();

    // Outbound audio pacing queue
    let outQueue = []; // array of { buf: Buffer }
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

    const startPacer = () => {
      if (outPacer) return;
      outPacer = setInterval(() => {
        // If queue has enough for one 20ms frame, send it.
        if (outQueueBytes >= OUT_CHUNK_BYTES) {
          sendTwilioAudioChunk(pullBytes(OUT_CHUNK_BYTES));
        } else {
          // If no audio is pending and we haven't sent audio recently, stop pacer to reduce jitter
          const idle = Date.now() - lastAssistantAudioAt;
          if (outQueueBytes === 0 && idle > 500) {
            stopPacer();
          }
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
      // Only allow one outstanding create request at a time
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
      // Only barge-in if we are actually playing assistant audio right now.
      if (!assistantIsActuallyPlayingAudio()) return;

      // Stop Twilio playback + drop queued frames (audible clean cut)
      if (streamSid) connection.send(JSON.stringify({ event: "clear", streamSid }));
      resetOutQueue();

      // Cancel only if OpenAI reports a response is truly active
      if (responseInFlight) {
        safeSendOpenAI({ type: "response.cancel" });
      }

      // Reset local state
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

          // If cancel was attempted but not active, just resync state (don’t spam)
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

        // Tool call: kb_search (ONLY handle from response.output_item.done)
        if (evt.type === "response.output_item.done" && evt.item?.type === "function_call") {
          const functionCall = evt.item;
          if (functionCall.name !== "kb_search" || !functionCall.call_id) return;

          const callId = functionCall.call_id;
          if (handledToolCalls.has(callId)) return;
          handledToolCalls.add(callId);

          const rawArgs = functionCall.arguments ?? functionCall.arguments_json ?? "{}";
          let args = {};
          try { args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs; } catch { args = {}; }

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

            latestMediaTimestamp = 0;

            // Reset response state
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
