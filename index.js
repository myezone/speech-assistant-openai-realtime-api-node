/**
 * index.js — Twilio Media Streams ↔ OpenAI Realtime (voice↔voice)
 *         + Vector Store kb_search tool
 *         + Call transcripts (caller + assistant) captured from OpenAI events
 *
 * Where to view what was produced:
 *  - Render logs: search for "USER TRANSCRIPT" / "ASSISTANT TRANSCRIPT"
 *  - API:
 *      GET /transcripts/latest
 *      GET /transcripts/:streamSid
 *      GET /transcripts (lists recent)
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
 *  - MAX_TRANSCRIPTS (default 50)  // in-memory retention
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
const DEFAULT_VOICE = VOICE || "alloy";
const TRANSCRIPTION_MODEL = OPENAI_TRANSCRIPTION_MODEL || "whisper-1";
const RETAIN_MAX = Math.max(1, Math.min(500, Number(MAX_TRANSCRIPTS) || 50));

// audio/pcmu ~ 8k bytes/sec => ~8 bytes/ms
const PCMU_BYTES_PER_MS = 8;

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

  // Merge tiny/rapid “Yes” / fragments into previous same-role turn if within 1.2s
  const now = Date.now();
  const last = rec.turns.length ? rec.turns[rec.turns.length - 1] : null;
  if (last && last.role === role && now - last.ts <= 1200) {
    // If either fragment is short, append; otherwise start new turn
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

// Twilio webhook: start Media Stream. Greeting comes from OpenAI Prompt (OPENAI_PROMPT_ID).
fastify.all("/incoming-call", async (request, reply) => {
  const host = request.headers["x-forwarded-host"] || request.headers.host;

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

    let responseInFlight = false;
    let queuedResponseCreate = false;

    // Assistant speaking / barge-in tracking
    let assistantSpeaking = false;
    let lastAssistantItem = null;
    let responseStartTimestampTwilio = null;
    let markQueue = [];
    const assistantAudioMsByItem = new Map(); // item_id -> ms sent (approx)

    // Tool call dedupe
    const handledToolCalls = new Set();

    // Transcript buffers
    const userTranscriptBufferByItem = new Map(); // item_id -> text
    const assistantTranscriptBufferByResp = new Map(); // response_id -> text

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
      // IMPORTANT: do NOT include "rate" under audio/pcmu (OpenAI will reject it)
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

          // ✅ all greeting + behavior defined in your saved prompt
          prompt: { id: OPENAI_PROMPT_ID },

          // ✅ KB tool (server executes Vector Store search)
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
      // Only barge-in if assistant is actively speaking or a response is still in flight
      if (!assistantSpeaking && !responseInFlight) return;

      // If we don't have enough info to truncate safely, just clear/cancel.
      const canTruncate = lastAssistantItem && responseStartTimestampTwilio != null;

      if (canTruncate) {
        const elapsedMs = latestMediaTimestamp - responseStartTimestampTwilio;
        const sentMs = assistantAudioMsByItem.get(lastAssistantItem) || 0;
        // Clamp and add a guard to avoid "already shorter than" errors
        const safeEndMs = Math.max(0, Math.min(elapsedMs, Math.max(0, sentMs - 50)));

        if (safeEndMs > 0) {
          safeSendOpenAI({
            type: "conversation.item.truncate",
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: safeEndMs,
          });
        }
      }

      if (responseInFlight) safeSendOpenAI({ type: "response.cancel" });

      responseInFlight = false;
      queuedResponseCreate = false;

      if (streamSid) connection.send(JSON.stringify({ event: "clear", streamSid }));

      assistantSpeaking = false;
      lastAssistantItem = null;
      responseStartTimestampTwilio = null;
      markQueue = [];
      assistantAudioMsByItem.clear();
    };

    openAiWs.on("open", () => {
      fastify.log.info("Connected to OpenAI Realtime");
      setTimeout(initializeSession, 50);
    });

    openAiWs.on("message", async (raw) => {
      try {
        const evt = JSON.parse(raw);

        if (evt.type === "error") {
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
          return;
        }

        if (evt.type === "response.done") {
          responseInFlight = false;
          assistantSpeaking = false;

          // Reset barge-in state after each completed response
          lastAssistantItem = null;
          responseStartTimestampTwilio = null;
          markQueue = [];
          assistantAudioMsByItem.clear();

          if (queuedResponseCreate) {
            queuedResponseCreate = false;
            requestResponseCreate("queued_after_response_done");
          }
          return;
        }

        // Caller transcript (streaming)
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

        // Assistant spoken transcript (streaming)
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

        // Forward assistant audio to Twilio (support both event names)
        const isAudioDelta =
          (evt.type === "response.audio.delta" || evt.type === "response.output_audio.delta") &&
          typeof evt.delta === "string" &&
          evt.delta.length > 0;

        if (isAudioDelta) {
          if (!streamSid) return; // can't forward yet

          connection.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: evt.delta },
            })
          );

          assistantSpeaking = true;

          if (responseStartTimestampTwilio == null) responseStartTimestampTwilio = latestMediaTimestamp;

          if (evt.item_id) {
            lastAssistantItem = evt.item_id;

            // approximate ms sent for this item from base64 size
            const b64 = evt.delta;
            const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
            const bytes = Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
            const ms = Math.floor(bytes / PCMU_BYTES_PER_MS);

            const prevMs = assistantAudioMsByItem.get(evt.item_id) || 0;
            assistantAudioMsByItem.set(evt.item_id, prevMs + ms);
          }

          sendMark();
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

            // initialize transcript record
            const rec = getOrCreateTranscript(streamSid);
            if (rec) rec.callSid = callSid;

            fastify.log.info({ streamSid, callSid }, "Incoming stream started");

            // reset per-call state
            latestMediaTimestamp = 0;
            responseInFlight = false;
            queuedResponseCreate = false;
            assistantSpeaking = false;
            lastAssistantItem = null;
            responseStartTimestampTwilio = null;
            markQueue = [];
            assistantAudioMsByItem.clear();
            handledToolCalls.clear();
            userTranscriptBufferByItem.clear();
            assistantTranscriptBufferByResp.clear();

            maybeGreet();
            break;
          }

          case "media":
            latestMediaTimestamp = data.media.timestamp;
            if (openAiWs.readyState === WebSocket.OPEN) {
              safeSendOpenAI({ type: "input_audio_buffer.append", audio: data.media.payload });
            }
            break;

          case "mark":
            if (markQueue.length > 0) markQueue.shift();
            break;

          case "stop":
            fastify.log.info({ streamSid }, "Received stop event from Twilio.");
            break;

          default:
            // ignore other events
            break;
        }
      } catch (err) {
        fastify.log.error({ streamSid, err: String(err) }, "Error parsing Twilio message");
      }
    });

    connection.on("close", () => {
      fastify.log.info({ streamSid }, "Client disconnected (Twilio WS).");

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
