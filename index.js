/**
 * index.js — Twilio Media Streams ↔ OpenAI Realtime
 * With call transfer functionality to +14026171324
 */

import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import twilio from "twilio";

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
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!OPENAI_PROMPT_ID) throw new Error("Missing OPENAI_PROMPT_ID");
if (!TWILIO_ACCOUNT_SID) throw new Error("Missing TWILIO_ACCOUNT_SID");
if (!TWILIO_AUTH_TOKEN) throw new Error("Missing TWILIO_AUTH_TOKEN");

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
  },
});

await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

const LISTEN_PORT = Number(PORT) || 10000;
const REALTIME_MODEL = "gpt-realtime";
const DEFAULT_VOICE = VOICE || "marin";
const TRANSCRIPTION_MODEL = OPENAI_TRANSCRIPTION_MODEL || "whisper-1";
const TRANSFER_NUMBER = "+14026171324";

/** --------- Helper Functions --------- */

/**
 * Handle call transfer by updating the active call with new TwiML
 */
async function handleCallTransfer(callSid, reason) {
  if (!callSid) {
    console.error("❌ Cannot transfer: callSid is null");
    return;
  }

  try {
    console.log(`📞 Transferring call ${callSid}. Reason: ${reason}`);

    await twilioClient.calls(callSid).update({
      twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">One moment please, I'm connecting you now.</Say>
  <Dial timeout="30" action="https://${PUBLIC_HOST}/call-transfer-status">
    <Number>${TRANSFER_NUMBER}</Number>
  </Dial>
  <Say voice="Polly.Joanna">
    I'm sorry, no one is available to take your call right now. 
    Please leave a message after the tone.
  </Say>
</Response>`
    });

    console.log(`✅ Transfer initiated for call ${callSid} to ${TRANSFER_NUMBER}`);
  } catch (error) {
    console.error(`❌ Transfer failed for call ${callSid}:`, error.message);
  }
}

/**
 * Handle knowledge base search
 */
async function handleKbSearch(query) {
  try {
    fastify.log.info({ query }, "🔍 KB Search requested");
    
    // TODO: Replace with your actual KB search logic
    // For now, returning a placeholder response
    return {
      success: true,
      results: [
        {
          content: "This is a placeholder KB response. Connect your actual knowledge base here.",
          relevance: 0.9
        }
      ]
    };
  } catch (error) {
    fastify.log.error({ error: error.message }, "❌ KB Search error");
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Finalize call state and cleanup
 */
function finalizeCallIfPossible(streamSid, callSid) {
  if (streamSid) {
    const st = getOrCreateState(streamSid);
    if (st && callSid) {
      st.callSid = callSid;
    }
    finalizeCall(streamSid);
  }
}

/** --------- Transcript aggregation (per callSid) --------- */
const callStateByStreamSid = new Map();

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
 * Routes
 * ----------------------------- */

fastify.get("/", async (_req, reply) => reply.send({ ok: true }));

/** Twilio webhook: incoming call -> TwiML Stream */
fastify.all("/incoming-call", async (request, reply) => {
  const callId = request.body?.CallSid || request.query?.CallSid || null;
  const from = request.body?.From || request.query?.From || null;
  const to = request.body?.To || request.query?.To || null;

  if (callId) {
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

/** Twilio status callback */
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

/** Call transfer status callback */
fastify.post("/call-transfer-status", async (req, reply) => {
  try {
    const callSid = req.body?.CallSid;
    const dialCallStatus = req.body?.DialCallStatus;
    const dialCallDuration = req.body?.DialCallDuration;

    fastify.log.info(
      { callSid, dialCallStatus, dialCallDuration },
      "📞 Transfer status update"
    );

    if (dialCallStatus === "completed") {
      fastify.log.info({ callSid, duration: dialCallDuration }, "✅ Transfer successful - call answered");
    } else if (dialCallStatus === "no-answer" || dialCallStatus === "busy") {
      fastify.log.info({ callSid }, "⚠️ Transfer failed - going to voicemail");
    } else if (dialCallStatus === "failed") {
      fastify.log.error({ callSid }, "❌ Transfer failed");
    }
  } catch (error) {
    fastify.log.error({ error: error.message }, "❌ Error in transfer status callback");
  }

  return reply.code(200).send("ok");
});

/** -----------------------------
 * WebSocket: Twilio ↔ OpenAI Realtime
 * ----------------------------- */
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
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

      // Handle audio output
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

      // Handle user transcription completion
      if (evt.type === "conversation.item.input_audio_transcription.completed") {
        const itemId = evt.item_id;
        const transcript = evt.transcript || "";
        userTranscriptBufferByItem.set(itemId, transcript);
        addTurn(streamSid, "user", transcript);
        return;
      }

      // Handle assistant transcription (streaming)
      if (evt.type === "response.audio_transcript.delta") {
        const respId = evt.response_id;
        const delta = evt.delta || "";
        const existing = assistantTranscriptBufferByResp.get(respId) || "";
        assistantTranscriptBufferByResp.set(respId, existing + delta);
        return;
      }

      // Handle assistant transcription completion
      if (evt.type === "response.audio_transcript.done") {
        const respId = evt.response_id;
        const full = assistantTranscriptBufferByResp.get(respId) || "";
        if (full) {
          addTurn(streamSid, "assistant", full);
          assistantTranscriptBufferByResp.delete(respId);
        }
        return;
      }

      // Handle function calls
      if (evt.type === "response.function_call_arguments.done") {
        const callId = evt.call_id;
        const functionName = evt.name;
        
        // Prevent duplicate handling
        if (handledToolCalls.has(callId)) return;
        handledToolCalls.add(callId);

        let args;
        try {
          args = JSON.parse(evt.arguments);
        } catch {
          args = {};
        }

        fastify.log.info({ functionName, args, callId }, "🔧 Function call received");

        // Handle kb_search
        if (functionName === "kb_search") {
          const result = await handleKbSearch(args.query);
          safeSendOpenAI({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify(result),
            },
          });
          safeSendOpenAI({ type: "response.create" });
          return;
        }

        // Handle transfer_to_human
        if (functionName === "transfer_to_human") {
          fastify.log.info({ callSid, reason: args.reason }, "📞 Initiating call transfer");
          
          // Send success response to AI
          safeSendOpenAI({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify({
                status: "transferring",
                message: "Transfer initiated successfully"
              }),
            },
          });
          
          // Let AI say goodbye message
          safeSendOpenAI({ type: "response.create" });
          
          // Wait for AI to speak, then transfer
          setTimeout(() => {
            handleCallTransfer(callSid, args.reason);
          }, 3000);
          
          return;
        }
      }
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
        
        // Store callSid in state
        const st = getOrCreateState(streamSid);
        if (st) st.callSid = callSid;
        
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
  console.log(`🚀 Server listening on port ${LISTEN_PORT}`);
});
