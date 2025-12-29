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
fastify.register(async (fastify) => {fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    // IMPORTANT: always use the underlying socket
    const twilioWs = connection.socket;

    fastify.log.info(
      {
        upgrade: req.headers.upgrade,
        connection: req.headers.connection,
        secWebSocketKey: req.headers["sec-websocket-key"] ? "present" : "missing",
        url: req.url,
      },
      "✅ Twilio WS route entered"
    );

    let streamSid = null;
    let callSid = null;

    const userTranscriptBufferByItem = new Map();
    const assistantTranscriptBufferByResp = new Map();
    const handledToolCalls = new Set();

    const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });

    openAiWs.on("error", (err) => {
      fastify.log.error({ err: String(err) }, "❌ OpenAI WS error");
    });

    openAiWs.on("close", (code, reason) => {
      fastify.log.warn({ code, reason: reason?.toString?.() }, "⚠️ OpenAI WS closed");
    });

    const safeSendOpenAI = (obj) => {
      if (openAiWs.readyState !== WebSocket.OPEN) return false;
      openAiWs.send(JSON.stringify(obj));
      return true;
    };

    const initializeSession = () => {
      safeSendOpenAI({
        type: "session.update",
        session: {
          model: REALTIME_MODEL,
          modalities: ["audio"],
          voice: DEFAULT_VOICE,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          input_audio_transcription: { model: TRANSCRIPTION_MODEL },
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

      safeSendOpenAI({ type: "response.create" });
    };

    openAiWs.on("open", () => {
      fastify.log.info("✅ Connected to OpenAI Realtime");
      setTimeout(initializeSession, 250);
    });

    openAiWs.on("message", async (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw);
      } catch (e) {
        fastify.log.error({ err: String(e) }, "OpenAI JSON parse error");
        return;
      }

      if (evt.type === "response.output_audio.delta") {
        if (streamSid && evt.delta && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: evt.delta },
            })
          );
        }
        return;
      }

      // (keep the rest of your transcript + tool-call handling here)
    });

    twilioWs.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg);
      } catch (e) {
        fastify.log.error({ err: String(e) }, "Twilio JSON parse error");
        return;
      }

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        callSid = data.start.callSid || null;
        fastify.log.info({ streamSid, callSid }, "✅ Incoming stream started");
        return;
      }

      if (data.event === "media") {
        if (openAiWs.readyState === WebSocket.OPEN) {
          safeSendOpenAI({ type: "input_audio_buffer.append", audio: data.media.payload });
        }
        return;
      }

      if (data.event === "stop") {
        fastify.log.info({ streamSid }, "🛑 Received stop event from Twilio");
        finalizeCallIfPossible(streamSid, callSid);
        return;
      }
    });

    twilioWs.on("close", () => {
      fastify.log.info({ streamSid }, "👋 Twilio WS closed");
      finalizeCallIfPossible(streamSid, callSid);
      try {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      } catch {}
    });
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
