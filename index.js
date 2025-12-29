/**
 * index.js — Twilio Media Streams ↔ OpenAI Realtime (minimal)
 *
 * Included recommendations only:
 * - Single OpenAI audio delta handler (no duplicates)
 * - No illegal top-level `return;`
 * - session.update shaped for Twilio (g711_ulaw, server_vad, transcription)
 * - Single safe Twilio send path (checks WS readyState)
 *
 * Plus: exactly TWO debug logs.
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
  PORT,
  VOICE,
  OPENAI_TRANSCRIPTION_MODEL,
  PUBLIC_HOST,
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!OPENAI_PROMPT_ID) throw new Error("Missing OPENAI_PROMPT_ID");

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info", // set to "debug" to see the 2 debug logs
  },
});

await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

const LISTEN_PORT = Number(PORT) || 10000;
const REALTIME_MODEL = "gpt-realtime";
const DEFAULT_VOICE = VOICE || "marin";
const TRANSCRIPTION_MODEL = OPENAI_TRANSCRIPTION_MODEL || "whisper-1";

/** --------- Minimal transcript aggregation (per callSid) --------- */
const callStateByStreamSid = new Map(); // streamSid -> { callSid, startedAt, turns: [{role,text,ts}] }

function getOrCreateState(streamSid) {
  if (!streamSid) return null;
  let st = callStateByStreamSid.get(streamSid);
  if (!st) {
    st = { callSid: null, startedAt: Date.now(), turns: [] };
    callStateByStreamSid.set(streamSid, st);
  }
  return st;
}

function addTurn(streamSid, role, text) {
  const st = getOrCreateState(streamSid);
  if (!st) return;

  const clean = String(text || "").trim();
  if (!clean) return;

  st.turns.push({ role, text: clean, ts: Date.now() });

  if (st.callSid) {
    const dbRole = role === "user" ? "caller" : "agent";
    void logUtterance({ callId: st.callSid, role: dbRole, text: clean }).catch(() => {});
  }
}

function finalizeCall(streamSid) {
  const st = callStateByStreamSid.get(streamSid);
  if (!st || !st.callSid) return;

  const durationMs = Math.max(0, Date.now() - st.startedAt);
  const durationSeconds = Math.max(0, Math.round(durationMs / 1000));
  const turns = st.turns.length;

  const firstUser = st.turns.find((t) => t.role === "user")?.text || "";
  const lastAgent = [...st.turns].reverse().find((t) => t.role === "assistant")?.text || "";
  const summaryText =
    `Caller: ${firstUser}`.slice(0, 400) + (lastAgent ? ` | Agent: ${lastAgent}`.slice(0, 400) : "");

  void setCallDurationFallback({ callId: st.callSid, durationSeconds }).catch(() => {});
  void saveCallSummary({
    callId: st.callSid,
    summaryText: summaryText || `Call ended. Turns: ${turns}. Duration: ${durationSeconds}s.`,
    summaryJson: { turns, durationMs, durationSeconds },
  }).catch(() => {});

  callStateByStreamSid.delete(streamSid);
}

/** -----------------------------
 * Basic routes
 * ----------------------------- */
fastify.get("/", async (_req, reply) => reply.send({ ok: true }));

/** -----------------------------
 * Twilio webhook: incoming call -> TwiML Stream
 * ----------------------------- */
fastify.all("/incoming-call", async (request, reply) => {
  const callId = request.body?.CallSid || request.query?.CallSid || null;
  const from = request.body?.From || request.query?.From || null;
  const to = request.body?.To || request.query?.To || null;

  if (callId) {
    // keep DB write, but no extra logging
    try {
      await upsertCallStart({ callId, from, to });
    } catch {}
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

/** -----------------------------
 * Twilio status callback
 * ----------------------------- */
fastify.post("/twilio/call-status", async (req, reply) => {
  try {
    const callId = req.body?.CallSid;
    const callStatus = req.body?.CallStatus;
    const callDuration = Number(req.body?.CallDuration || 0);

    if (callId && callStatus === "completed") {
      await setOfficialCallDuration({
        callId,
        durationSeconds: callDuration,
        status: callStatus,
      });
    }
  } catch {}

  return reply.code(200).send("ok");
});

/** -----------------------------
 * WebSocket: Twilio ↔ OpenAI Realtime
 * ----------------------------- */
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection) => {
    let streamSid = null;
    let callSid = null;

    const userTranscriptBufByItem = new Map();
    const assistantTranscriptBufByResp = new Map();

    const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });

    const safeSendOpenAI = (obj) => {
      if (openAiWs.readyState !== WebSocket.OPEN) return false;
      openAiWs.send(JSON.stringify(obj));
      return true;
    };

    const safeSendTwilio = (obj) => {
      const twilioWs = connection.socket || connection;
      if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN) return false;
      twilioWs.send(JSON.stringify(obj));
      return true;
    };
   
    const initializeSession = () => {
      safeSendOpenAI({
        type: "session.update",
        session: {
          model: REALTIME_MODEL,
          modalities: ["audio"],
          voice: DEFAULT_VOICE,
          // Twilio Media Streams audio format (8kHz µ-law)
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          input_audio_transcription: { model: TRANSCRIPTION_MODEL },
          prompt: { id: OPENAI_PROMPT_ID },
        },
      });

      // greet
      safeSendOpenAI({ type: "response.create" });
    };

    openAiWs.on("open", () => {
      // DEBUG LOG #1 (only)
      fastify.log.debug({ streamSid }, "debug: openai_ws_open");
      setTimeout(initializeSession, 250);
    });

openAiWs.on("message", async (raw) => {
  try {
    const evt = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));

    // ========================================
    // Single audio handler (NO DUPLICATES)
    // ========================================
    if (evt.type === "response.output_audio.delta") {
      if (streamSid && evt.delta) {
        safeSendTwilio({
          event: "media",
          streamSid,
          media: { payload: evt.delta }, // base64 g711_ulaw
        });
      }
      return;
    }

    // ========================================
    // Caller transcript deltas/completed
    // ========================================
    if (evt.type === "conversation.item.input_audio_transcription.delta") {
      const itemId = evt.item_id;
      const prev = userTranscriptBufByItem.get(itemId) || "";
      userTranscriptBufByItem.set(itemId, prev + (evt.delta || ""));
      return;
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      const itemId = evt.item_id;
      const finalText = (evt.transcript || userTranscriptBufByItem.get(itemId) || "").trim();
      userTranscriptBufByItem.delete(itemId);
      if (finalText) addTurn(streamSid, "user", finalText);
      return;
    }

    // ========================================
    // Assistant transcript deltas/done (if provided)
    // ========================================
    if (evt.type === "response.output_audio_transcript.delta") {
      const rid = evt.response_id;
      const prev = assistantTranscriptBufByResp.get(rid) || "";
      assistantTranscriptBufByResp.set(rid, prev + (evt.delta || ""));
      return;
    }

    if (evt.type === "response.output_audio_transcript.done") {
      const rid = evt.response_id;
      const finalText = (evt.transcript || assistantTranscriptBufByResp.get(rid) || "").trim();
      assistantTranscriptBufByResp.delete(rid);
      if (finalText) addTurn(streamSid, "assistant", finalText);
      return;
    }

    // ========================================
    // Tool call: kb_search (vector store)
    // ========================================
    if (evt.type === "response.output_item.done" && evt.item?.type === "function_call") {
      const fc = evt.item;

      if (fc.name !== "kb_search" || !fc.call_id) return;
      if (handledToolCalls.has(fc.call_id)) return;
      handledToolCalls.add(fc.call_id);

      let args = {};
      try {
        args = typeof fc.arguments === "string" ? JSON.parse(fc.arguments) : fc.arguments || {};
      } catch {
        args = {};
      }

      const query = String(args?.query || "").trim() || "callsanswered";

      let passages = "";
      try {
        const vsJson = await vectorStoreSearch(query);
        passages = extractPassages(vsJson);
      } catch {
        passages = "";
      }

      safeSendOpenAI({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: fc.call_id,
          output: JSON.stringify({ query, passages }),
        },
      });

      // Ask the model to continue now that tool output is provided
      safeSendOpenAI({ type: "response.create" });
      return;
    }
  } catch {
    // keep quiet; no extra logs
  }
});

    
    const onTwilioMessage = (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.event === "start") {
          streamSid = data.start.streamSid;
          callSid = data.start.callSid || null;

          const st = getOrCreateState(streamSid);
          if (st) st.callSid = callSid;

          // DEBUG LOG #2 (only)
          fastify.log.debug({ streamSid, callSid }, "debug: twilio_stream_started");
          return;
        }

        if (data.event === "media") {
          safeSendOpenAI({ type: "input_audio_buffer.append", audio: data.media.payload });
          return;
        }

        if (data.event === "stop") {
          finalizeCall(streamSid);
          return;
        }
      } catch {
        // no extra logs
      }
    };

    // fastify-ws gives either a WebSocket-like object or wraps it; handle both.
    if (typeof connection.on === "function") {
      connection.on("message", onTwilioMessage);
      connection.on("close", () => {
        finalizeCall(streamSid);
        try {
          if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
        } catch {}
      });
    } else if (connection.socket && typeof connection.socket.on === "function") {
      connection.socket.on("message", onTwilioMessage);
      connection.socket.on("close", () => {
        finalizeCall(streamSid);
        try {
          if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
        } catch {}
      });
    }
  });
});

/** -----------------------------
 * Start server
 * ----------------------------- */
fastify.listen({ port: LISTEN_PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});
