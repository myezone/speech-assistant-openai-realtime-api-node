/**
 * index.js — Twilio Media Streams ↔ OpenAI Realtime (voice-to-voice)
 *          + Vector Store kb_search tool
 *          + Transcripts (caller + assistant) captured from OpenAI events
 *
 * Access transcripts at:
 *   GET /transcripts/latest
 *   GET /transcripts/:streamSid
 *
 * Env vars required:
 *   OPENAI_API_KEY
 *   OPENAI_PROMPT_ID
 *   VECTOR_STORE_ID
 *
 * Optional:
 *   PORT (default 10000)
 *   VOICE (default "alloy")
 *   OPENAI_TRANSCRIPTION_MODEL (default "whisper-1")
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
  VOICE,
  PORT,
  OPENAI_TRANSCRIPTION_MODEL,
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

const LISTEN_PORT = PORT || 10000;
const REALTIME_MODEL = "gpt-realtime";
const DEFAULT_VOICE = VOICE || "alloy";
const TRANSCRIPTION_MODEL = OPENAI_TRANSCRIPTION_MODEL || "whisper-1";

// In-memory transcript store (resets on deploy / restart)
const transcriptsByStreamSid = new Map(); // streamSid -> { callSid, startedAt, endedAt, turns: [{role,text,ts}], events: [] }
let latestStreamSid = null;

/**
 * Twilio mu-law is 8k, 8-bit => 8000 bytes/sec => ~8 bytes/ms.
 * For audio/pcmu the bytes-per-ms is roughly 8.
 */
const PCMU_BYTES_PER_MS = 8;

fastify.get("/", async (_req, reply) => {
  reply.send({ ok: true, message: "Voice IVA server running" });
});

// See latest transcript (JSON)
fastify.get("/transcripts/latest", async (_req, reply) => {
  if (!latestStreamSid || !transcriptsByStreamSid.has(latestStreamSid)) {
    return reply.code(404).send({ error: "No transcripts yet." });
  }
  return reply.send(transcriptsByStreamSid.get(latestStreamSid));
});

// See transcript by streamSid
fastify.get("/transcripts/:streamSid", async (req, reply) => {
  const { streamSid } = req.params;
  const data = transcriptsByStreamSid.get(streamSid);
  if (!data) return reply.code(404).send({ error: "Not found" });
  return reply.send(data);
});

// Optional: quick check if vector store has files
fastify.get("/kb-status", async (_request, reply) => {
  try {
    const resp = await fetch(
      `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
        },
      }
    );
    const json = await resp.json();
    reply.code(resp.status).send(json);
  } catch (e) {
    reply.code(500).send({ error: String(e) });
  }
});

// Twilio webhook: return TwiML that starts Media Stream immediately.
// Greeting is NOT here — OpenAI greets first using your OPENAI_PROMPT_ID.
fastify.all("/incoming-call", async (request, reply) => {
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  fastify.log.info({ host }, "Twilio incoming-call host");

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;

  reply.code(200).type("text/xml").send(twimlResponse);
});

// Vector Store search used by kb_search tool
async function vectorStoreSearch(query) {
  const resp = await fetch(
    `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({
        query,
        max_num_results: 5,
      }),
    }
  );

  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(`Vector store search failed: ${resp.status} ${JSON.stringify(json)}`);
  }
  return json;
}

function extractPassages(vsJson) {
  const rows = Array.isArray(vsJson?.data) ? vsJson.data : [];
  const passages = rows
    .slice(0, 5)
    .map((r) => {
      const contentArr = Array.isArray(r?.content) ? r.content : [];
      const textJoined = contentArr
        .map((c) => {
          const t = c?.text;
          if (typeof t === "string") return t;
          if (t && typeof t === "object" && typeof t.value === "string") return t.value;
          return "";
        })
        .filter(Boolean)
        .join("\n\n");
      return textJoined.trim();
    })
    .filter(Boolean);

  return passages.join("\n---\n");
}

fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, _req) => {
    fastify.log.info("Client connected (Twilio WS)");

    let streamSid = null;
    let callSid = null;
    let latestMediaTimestamp = 0;

    // assistant audio tracking (for safe truncation)
    let lastAssistantItem = null;
    const assistantAudioMsByItem = new Map(); // item_id -> ms sent so far
    let responseStartTimestampTwilio = null;
    let markQueue = [];

    // response ordering
    let responseInFlight = false;
    let queuedResponseCreate = false;
    let greetedThisCall = false;

    // tool call dedupe
    const handledToolCalls = new Set();

    // transcript buffers for streaming deltas
    const userTranscriptBufferByItem = new Map();       // item_id -> accumulated text
    const assistantTranscriptBufferByResp = new Map();  // response_id -> accumulated text

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`,
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

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
      if (reason) fastify.log.info({ reason }, "Sent response.create");
    };

    const initializeSession = () => {
      // IMPORTANT:
      // - No "rate" field under audio/pcmu formats (OpenAI rejects it)
      // - Enable input transcription here
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

              // ✅ caller transcription
              transcription: { model: TRANSCRIPTION_MODEL },
            },
            output: {
              format: { type: "audio/pcmu" },
              voice: DEFAULT_VOICE,
            },
          },

          // ✅ prompt controls greeting + behavior
          prompt: { id: OPENAI_PROMPT_ID },

          // ✅ tool for KB search
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

    const ensureTranscriptRecord = () => {
      if (!streamSid) return null;
      if (!transcriptsByStreamSid.has(streamSid)) {
        transcriptsByStreamSid.set(streamSid, {
          streamSid,
          callSid: callSid || null,
          startedAt: Date.now(),
          endedAt: null,
          turns: [],
        });
        latestStreamSid = streamSid;
      }
      return transcriptsByStreamSid.get(streamSid);
    };

    const addTurn = (role, text) => {
      const rec = ensureTranscriptRecord();
      if (!rec) return;
      const clean = (text || "").trim();
      if (!clean) return;
      rec.turns.push({ role, text: clean, ts: Date.now() });

      // Also visible in Render logs
      if (role === "user") fastify.log.info({ streamSid, user: clean }, "USER TRANSCRIPT");
      if (role === "assistant") fastify.log.info({ streamSid, assistant: clean }, "ASSISTANT TRANSCRIPT");
    };

    const sendMark = () => {
      if (!streamSid) return;
      connection.send(
        JSON.stringify({
          event: "mark",
          streamSid,
          mark: { name: "responsePart" },
        })
      );
      markQueue.push("responsePart");
    };

    const handleBargeIn = () => {
      if (!lastAssistantItem || responseStartTimestampTwilio == null) return;

      const elapsedMs = latestMediaTimestamp - responseStartTimestampTwilio;
      const sentMs = assistantAudioMsByItem.get(lastAssistantItem) || 0;

      // Clamp truncate to audio that was actually emitted.
      // Subtract a tiny guard (50ms) to avoid "already shorter" errors.
      const safeEndMs = Math.max(0, Math.min(elapsedMs, Math.max(0, sentMs - 50)));

      // If we haven't emitted enough audio to truncate safely, just cancel/clear.
      if (safeEndMs > 0) {
        safeSendOpenAI({
          type: "conversation.item.truncate",
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: safeEndMs,
        });
      }

      safeSendOpenAI({ type: "response.cancel" });
      responseInFlight = false;
      queuedResponseCreate = false;

      if (streamSid) connection.send(JSON.stringify({ event: "clear", streamSid }));

      markQueue = [];
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
      assistantAudioMsByItem.clear();
    };

    openAiWs.on("open", () => {
      fastify.log.info("Connected to the OpenAI Realtime API");
      setTimeout(initializeSession, 50);
    });

    openAiWs.on("message", async (data) => {
      try {
        const evt = JSON.parse(data);

        if (evt.type === "error") {
          fastify.log.error({ openai_error: evt }, "OPENAI ERROR EVENT");
        }

        // Track response lifecycle
        if (evt.type === "response.created") {
          responseInFlight = true;
        } else if (evt.type === "response.done") {
          responseInFlight = false;
          if (queuedResponseCreate) {
            queuedResponseCreate = false;
            requestResponseCreate("queued_after_response_done");
          }
        }

        // Speak first after session config
        if (evt.type === "session.updated" && !greetedThisCall) {
          greetedThisCall = true;
          requestResponseCreate("initial_greeting");
        }

        // ✅ Caller transcription (streaming)
        if (evt.type === "conversation.item.input_audio_transcription.delta") {
          const itemId = evt.item_id;
          const delta = evt.delta || "";
          const prev = userTranscriptBufferByItem.get(itemId) || "";
          userTranscriptBufferByItem.set(itemId, prev + delta);
        }

        if (evt.type === "conversation.item.input_audio_transcription.completed") {
          const itemId = evt.item_id;
          const finalText = (evt.transcript || userTranscriptBufferByItem.get(itemId) || "").trim();
          userTranscriptBufferByItem.delete(itemId);
          if (finalText) addTurn("user", finalText);
        }

        // ✅ Assistant transcript of its spoken audio (streaming)
        if (evt.type === "response.output_audio_transcript.delta") {
          const rid = evt.response_id;
          const delta = evt.delta || "";
          const prev = assistantTranscriptBufferByResp.get(rid) || "";
          assistantTranscriptBufferByResp.set(rid, prev + delta);
        }

        if (evt.type === "response.output_audio_transcript.done") {
          const rid = evt.response_id;
          const finalText = (evt.transcript || assistantTranscriptBufferByResp.get(rid) || "").trim();
          assistantTranscriptBufferByResp.delete(rid);
          if (finalText) addTurn("assistant", finalText);
        }

        // ✅ Forward assistant audio to Twilio (handle both event names recall)
        const isAudioDelta =
          (evt.type === "response.audio.delta" || evt.type === "response.output_audio.delta") &&
          typeof evt.delta === "string" &&
          evt.delta.length > 0;

        if (isAudioDelta) {
          if (streamSid) {
            connection.send(
              JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: evt.delta },
              })
            );
          }

          // Establish response start timing on first audio output
          if (responseStartTimestampTwilio == null) responseStartTimestampTwilio = latestMediaTimestamp;

          // Track which assistant item we are speaking
          if (evt.item_id) {
            lastAssistantItem = evt.item_id;

            // estimate how many ms we've emitted for this item
            // base64 length -> bytes: (len * 3/4) minus padding; rough is ok for clamping
            const b64 = evt.delta;
            const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
            const bytes = Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
            const ms = Math.floor(bytes / PCMU_BYTES_PER_MS);

            const prevMs = assistantAudioMsByItem.get(evt.item_id) || 0;
            assistantAudioMsByItem.set(evt.item_id, prevMs + ms);
          }

          sendMark();
        }

        // Barge-in signal
        if (evt.type === "input_audio_buffer.speech_started") {
          handleBargeIn();
        }

        // Tool calls arrive via response.output_item.done
        if (evt.type === "response.output_item.done" && evt.item?.type === "function_call") {
          const functionCall = evt.item;

          if (functionCall.name === "kb_search" && functionCall.call_id) {
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

            const query = (args?.query || "").toString().trim();
            fastify.log.info({ query, callId }, "kb_search tool call");

            let vsJson;
            try {
              vsJson = await vectorStoreSearch(query || "callsanswered");
            } catch (e) {
              fastify.log.error({ err: String(e) }, "KB search error");
              vsJson = { data: [] };
            }

            const passages = extractPassages(vsJson);

            safeSendOpenAI({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: callId,
                output: JSON.stringify({ query, passages }),
              },
            });

            requestResponseCreate("after_kb_search_output");
          }
        }
      } catch (err) {
        fastify.log.error({ err: String(err) }, "Error processing OpenAI message");
      }
    });

    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid;
            callSid = data.start.callSid || data.start?.callSid || null;
            latestStreamSid = streamSid;

            fastify.log.info({ streamSid, callSid }, "Incoming stream started");
            latestMediaTimestamp = 0;

            // reset per-call state
            lastAssistantItem = null;
            assistantAudioMsByItem.clear();
            responseStartTimestampTwilio = null;
            markQueue = [];
            responseInFlight = false;
            queuedResponseCreate = false;
            greetedThisCall = false;
            handledToolCalls.clear();
            userTranscriptBufferByItem.clear();
            assistantTranscriptBufferByResp.clear();

            ensureTranscriptRecord();
            break;

          case "media":
            latestMediaTimestamp = data.media.timestamp;
            if (openAiWs.readyState === WebSocket.OPEN) {
              safeSendOpenAI({ type: "input_audio_buffer.append", audio: data.media.payload });
            }
            break;

          case "connected":
            fastify.log.info("Received non-media event: connected");
            break;

          case "stop":
            fastify.log.info("Received stop event from Twilio.");
            break;

          case "mark":
            if (markQueue.length > 0) markQueue.shift();
            break;

          default:
            fastify.log.info({ event: data.event }, "Received non-media event");
        }
      } catch (err) {
        fastify.log.error({ err: String(err) }, "Error parsing Twilio message");
      }
    });

    connection.on("close", () => {
      fastify.log.info("Client disconnected (Twilio WS).");

      // finalize transcript record
      if (streamSid && transcriptsByStreamSid.has(streamSid)) {
        const rec = transcriptsByStreamSid.get(streamSid);
        rec.endedAt = Date.now();
        rec.callSid = rec.callSid || callSid || null;

        fastify.log.info(
          { streamSid, callSid: rec.callSid, turns: rec.turns.length },
          "CALL TRANSCRIPT SUMMARY"
        );
      }

      try {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(1000, "twilio_disconnected");
        else openAiWs.terminate();
      } catch {}
    });

    openAiWs.on("close", () => fastify.log.info("Disconnected from OpenAI Realtime API"));
    openAiWs.on("error", (e) => fastify.log.error({ err: String(e) }, "OpenAI WS error"));
  });
});

fastify.listen({ port: LISTEN_PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Server is listening on port ${LISTEN_PORT}`);
});
