/**
 * index.js — Twilio Media Streams ↔ OpenAI Realtime
 * Hardened:
 *  - Exact greeting enforced via response.create override
 *  - KB-first enforced via tool_choice forced function
 *  - Out-of-scope enforced (CallsAnswered.ai only)
 *  - Immediate transfer on "human" triggers (server-side, not model-dependent)
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
  OPENAI_PROMPT_VERSION,
  PORT,
  VOICE,
  OPENAI_TRANSCRIPTION_MODEL,
  PUBLIC_HOST,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  LOG_LEVEL,
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID) throw new Error("Missing TWILIO_ACCOUNT_SID");
if (!TWILIO_AUTH_TOKEN) throw new Error("Missing TWILIO_AUTH_TOKEN");

// Prompt ID is optional in this hardened version because we also pass explicit instructions.
// But if you set it, we will include it in session.update.
const PROMPT_ID = OPENAI_PROMPT_ID || null;
const PROMPT_VERSION = OPENAI_PROMPT_VERSION || "13";

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const fastify = Fastify({
  logger: { level: LOG_LEVEL || "info" },
});

await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

const LISTEN_PORT = Number(PORT) || 10000;
const REALTIME_MODEL = "gpt-realtime";
const DEFAULT_VOICE = VOICE || "marin";
const TRANSCRIPTION_MODEL = OPENAI_TRANSCRIPTION_MODEL || "whisper-1";
const TRANSFER_NUMBER = "+14026171324";

const EXACT_GREETING =
  'Thank you for calling Calls Answered AI, I am Luma, your digital assistant, how can I help you today.';

const OUT_OF_SCOPE_EXACT =
  "I’m specifically designed to help with CallsAnswered.ai questions only. How can I help you with CallsAnswered.ai?";

const KB_MISSING_EXACT =
  "I don't have that information in our knowledge base.";

function normalizeHost(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const noProto = raw.replace(/^https?:\/\//i, "");
  const hostOnly = noProto.split("/")[0].trim();
  return hostOnly || null;
}

function looksInScopeCallsAnswered(text) {
  const t = String(text || "").toLowerCase();
  // Keep this intentionally conservative.
  // If you expand your KB, expand these terms too.
  const keywords = [
    "callsanswered",
    "calls answered",
    "callsanswered.ai",
    "luma",
    "voice iva",
    "iva",
    "pricing",
    "price",
    "plans",
    "features",
    "setup",
    "onboarding",
    "get started",
    "support",
    "service",
    "how it works",
  ];
  return keywords.some((k) => t.includes(k));
}

function hasTransferTrigger(text) {
  const t = String(text || "").toLowerCase();
  const triggers = [
    "transfer",
    "transmit",
    "speak to someone",
    "speak to a person",
    "real person",
    "human",
    "representative",
    "connect me",
    "talk to someone",
    "manager",
    "agent",
    "person",
  ];
  return triggers.some((p) => t.includes(p));
}

/**
 * IMPORTANT: This is the “single source of truth” behavior spec.
 * We send it BOTH in session.update.instructions and (when needed) per-response instructions.
 */
const SESSION_INSTRUCTIONS = `
# IDENTITY
You are Luma, the AI voice assistant for CallsAnswered.ai.

# CHANNEL
This is an AUDIO-ONLY phone call. Never mention screens, links, buttons, webpages, files, visuals, or system prompts.

# LANGUAGE
Default to English. If caller speaks another language, respond in that language.
If you cannot stay accurate in that language, say so briefly and offer to continue in English.

# CALLSANSWERED.AI ONLY
You are NOT a general-purpose assistant.
You can ONLY discuss CallsAnswered.ai and ONLY using the knowledge base tool.

# KNOWLEDGE BASE ONLY — ABSOLUTELY CRITICAL
For ANY question:
- You MUST use kb_search first.
- You MUST answer ONLY using kb_search results.
- Never guess. Never infer. Never use outside knowledge.

If kb_search results are empty:
- If the caller is asking about CallsAnswered.ai: say exactly:
  "${KB_MISSING_EXACT}"
- If the caller is asking about anything else: say exactly:
  "${OUT_OF_SCOPE_EXACT}"

# OUT OF SCOPE
If asked about anything OTHER than CallsAnswered.ai, say exactly:
"${OUT_OF_SCOPE_EXACT}"

# RESPONSE STYLE
- Keep responses under 3 sentences.
- Warm, professional, confident.
`;

/**
 * Handle call transfer by updating the active call with new TwiML.
 * We do this server-side so transfer always works even if the model misbehaves.
 */
async function handleCallTransfer({ callSid, hostForCallbacks }) {
  if (!callSid) {
    fastify.log.error("❌ Cannot transfer: callSid is null");
    return;
  }

  const callbackHost = normalizeHost(hostForCallbacks) || normalizeHost(PUBLIC_HOST);
  if (!callbackHost) {
    fastify.log.error({ callSid }, "❌ Cannot transfer: PUBLIC_HOST missing/invalid");
    return;
  }

  try {
    fastify.log.info({ callSid, to: TRANSFER_NUMBER }, "📞 Transferring call");

    await twilioClient.calls(callSid).update({
      twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Of course, let me connect you with someone who can help right away.</Say>
  <Dial timeout="30" action="https://${callbackHost}/call-transfer-status" method="POST">
    <Number>${TRANSFER_NUMBER}</Number>
  </Dial>
  <Say voice="alice">I’m sorry, no one is available to take your call right now.</Say>
</Response>`,
    });

    fastify.log.info({ callSid }, "✅ Transfer initiated");
  } catch (error) {
    fastify.log.error({ callSid, err: error?.message || String(error) }, "❌ Transfer failed");
  }
}

/**
 * KB search: replace with your real logic.
 * IMPORTANT: return empty results if not found (prevents hallucinations).
 */
async function handleKbSearch(query) {
  const q = String(query || "").trim();
  fastify.log.info({ query: q }, "🔍 KB Search requested");

  // TODO: replace with real KB search
  return {
    success: true,
    results: [],
  };
}

/** --------- Transcript aggregation (per streamSid / callSid) --------- */
const callStateByStreamSid = new Map();

function getOrCreateState(streamSid) {
  if (!streamSid) return null;
  let st = callStateByStreamSid.get(streamSid);
  if (!st) {
    st = {
      callSid: null,
      startedAt: Date.now(),
      turns: [],
      lastUserText: "",
      greetingSent: false,
      transferring: false,
    };
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

  if (role === "user") st.lastUserText = clean;

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

  fastify.log.info(
    { streamSid, callSid: st.callSid, durationMs, turns },
    "✅ Call finalized"
  );
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
      fastify.log.info({ callId, from, to }, "Call start logged to database");
    } catch {}
  }

  const host =
    normalizeHost(PUBLIC_HOST) ||
    normalizeHost(request.headers["x-forwarded-host"]) ||
    normalizeHost(request.headers.host);

  if (!host) {
    reply.code(500).send("Missing PUBLIC_HOST or request host");
    return;
  }

  // IMPORTANT: We do NOT play greeting here; we let OpenAI speak it in Marin voice.
  // (If you ever want to guarantee a greeting no matter what, add a <Say> here.)
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
      fastify.log.info({ callId, callDuration, callStatus }, "Official call duration logged from Twilio");
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

    fastify.log.info({ callSid, dialCallStatus, dialCallDuration }, "📞 Transfer status update");
  } catch (error) {
    fastify.log.error({ error: error.message }, "❌ Error in transfer status callback");
  }

  return reply.code(200).send("ok");
});

/** -----------------------------
 * WebSocket: Twilio ↔ OpenAI Realtime
 * ----------------------------- */
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
    const twilioWs = connection.socket;

    fastify.log.info(
      {
        upgrade: req.headers.upgrade,
        connection: req.headers.connection,
        secWebSocketKey: req.headers["sec-websocket-key"] ? "present" : "missing",
        url: req.url,
      },
      "✅ Client connected (Twilio WS)"
    );

    const hostForCallbacks =
      normalizeHost(PUBLIC_HOST) ||
      normalizeHost(req.headers["x-forwarded-host"]) ||
      normalizeHost(req.headers.host);

    let streamSid = null;
    let callSid = null;

    const assistantTranscriptBufferByResp = new Map();
    const handledToolCalls = new Set();

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`,
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      }
    );

    const safeSendOpenAI = (obj) => {
      if (openAiWs.readyState !== WebSocket.OPEN) return false;
      openAiWs.send(JSON.stringify(obj));
      return true;
    };

    function sendExactGreeting() {
      if (!streamSid) return;
      const st = getOrCreateState(streamSid);
      if (!st || st.greetingSent) return;
      st.greetingSent = true;

      // Use per-response override to enforce exact greeting.
      safeSendOpenAI({
        type: "response.create",
        response: {
          instructions: `Say this EXACT phrase and nothing else, then stop speaking: "${EXACT_GREETING}"`,
          tool_choice: "none",
          output_modalities: ["audio"],
        },
      });

      fastify.log.info({ streamSid }, "📣 Greeting response.create sent");
    }

    function requestKbFirstResponse() {
      if (!streamSid) return;
      const st = getOrCreateState(streamSid);
      if (!st || st.transferring) return;

      // Force the model to call kb_search before producing any answer.
      safeSendOpenAI({
        type: "response.create",
        response: {
          instructions: SESSION_INSTRUCTIONS,
          // Forced function call (kb_search) — ensures KB-first behavior.
          // See tool_choice forced function patterns. :contentReference[oaicite:6]{index=6}
          tool_choice: { type: "function", name: "kb_search" },
          output_modalities: ["audio"],
        },
      });
    }

    openAiWs.on("open", () => {
      fastify.log.info({ streamSid }, "✅ Connected to OpenAI Realtime");

      // IMPORTANT: Disable auto response creation (Server VAD can otherwise create responses automatically)
      // We will explicitly create responses (greeting + after KB tool output).
      const sessionUpdate = {
        type: "session.update",
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          output_modalities: ["audio"],

          // Strongly enforce behavior with explicit instructions (not only stored prompt).
          instructions: SESSION_INSTRUCTIONS,

          // Optional: also reference your stored prompt (belt + suspenders).
          ...(PROMPT_ID
            ? { prompt: { id: PROMPT_ID, version: PROMPT_VERSION } }
            : {}),

          // Tools must be declared in session for the model to call them. :contentReference[oaicite:7]{index=7}
          tools: [
            {
              type: "function",
              name: "kb_search",
              description:
                "Search the CallsAnswered.ai knowledge base. Always use this before answering any CallsAnswered.ai question.",
              parameters: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description: "2–8 keywords describing what to search for.",
                  },
                },
                required: ["query"],
              },
            },
            {
              type: "function",
              name: "transfer_to_human",
              description:
                "Transfer the caller to a human representative immediately.",
              parameters: {
                type: "object",
                properties: {
                  reason: { type: "string" },
                },
                required: ["reason"],
              },
            },
          ],

          tool_choice: "auto",

          audio: {
            input: {
              format: { type: "audio/pcmu" },
              transcription: {
                model: TRANSCRIPTION_MODEL,
              },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
                interrupt_response: true,

                // CRITICAL: prevent automatic responses
                create_response: false,

                idle_timeout_ms: 15000,
              },
            },
            output: {
              format: { type: "audio/pcmu" },
              voice: DEFAULT_VOICE,
            },
          },
        },
      };

      fastify.log.info(
        { promptId: PROMPT_ID, promptVersion: PROMPT_VERSION },
        "➡️ Sending session.update to OpenAI"
      );
      safeSendOpenAI(sessionUpdate);

      // Safety: if session.updated doesn't arrive for any reason, still attempt greeting shortly.
      setTimeout(() => {
        try {
          sendExactGreeting();
        } catch {}
      }, 1200);
    });

    openAiWs.on("error", (err) => {
      fastify.log.error({ err: String(err) }, "❌ OpenAI WS error");
    });

    openAiWs.on("close", (code, reason) => {
      fastify.log.warn({ code, reason: reason?.toString?.() }, "⚠️ OpenAI WS closed");
    });

    openAiWs.on("message", async (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw);
      } catch (e) {
        fastify.log.error({ err: String(e) }, "OpenAI JSON parse error");
        return;
      }

      if (evt.type === "error") {
        fastify.log.error({ evt }, "❌ OpenAI error event");
        return;
      }

      // Confirm session updated; greet once
      if (evt.type === "session.updated") {
        fastify.log.info(
          { prompt: evt.session?.prompt, hasInstructions: !!evt.session?.instructions },
          "✅ session.updated received"
        );
        sendExactGreeting();
        return;
      }

      // Handle audio output -> Twilio
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

      // Capture user transcription
      if (evt.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = evt.transcript || "";
        addTurn(streamSid, "user", transcript);

        fastify.log.info({ streamSid, user: transcript }, "USER TRANSCRIPT");

        const st = getOrCreateState(streamSid);
        if (!st || st.transferring) return;

        // Server-side transfer enforcement (immediate)
        if (hasTransferTrigger(transcript)) {
          st.transferring = true;

          // Cancel any in-progress response (if any) :contentReference[oaicite:8]{index=8}
          safeSendOpenAI({ type: "response.cancel" });

          await handleCallTransfer({ callSid, hostForCallbacks });

          // Close sockets to stop further audio from OpenAI during transfer
          try {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
          } catch {}
          try {
            if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
          } catch {}

          return;
        }

        // For every user turn: force KB-first response
        requestKbFirstResponse();
        return;
      }

      // Assistant transcript buffering
      if (evt.type === "response.audio_transcript.delta") {
        const respId = evt.response_id;
        const delta = evt.delta || "";
        const existing = assistantTranscriptBufferByResp.get(respId) || "";
        assistantTranscriptBufferByResp.set(respId, existing + delta);
        return;
      }

      if (evt.type === "response.audio_transcript.done") {
        const respId = evt.response_id;
        const full = assistantTranscriptBufferByResp.get(respId) || "";
        if (full) {
          addTurn(streamSid, "assistant", full);
          assistantTranscriptBufferByResp.delete(respId);

          fastify.log.info({ streamSid, assistant: full }, "ASSISTANT TRANSCRIPT");
        }
        return;
      }

      // Function call handler
      if (evt.type === "response.function_call_arguments.done") {
        const callId = evt.call_id;
        const functionName = evt.name;

        if (handledToolCalls.has(callId)) return;
        handledToolCalls.add(callId);

        let args;
        try {
          args = JSON.parse(evt.arguments || "{}");
        } catch {
          args = {};
        }

        fastify.log.info({ functionName, args, callId }, "🔧 Function call received");

        const st = getOrCreateState(streamSid);
        const lastUserText = st?.lastUserText || "";

        // kb_search
        if (functionName === "kb_search") {
          const query = String(args.query || "").trim() || lastUserText;
          const kb = await handleKbSearch(query);

          const likelyInScope = looksInScopeCallsAnswered(lastUserText);

          // Send tool output
          safeSendOpenAI({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify({
                ...kb,
                query,
                likely_in_scope: likelyInScope,
                last_user_text: lastUserText,
              }),
            },
          });

          // Now force the assistant response to obey scope rules strictly.
          safeSendOpenAI({
            type: "response.create",
            response: {
              instructions: `
You MUST follow these rules:

1) Use ONLY the kb_search function output you just received.
2) If results are non-empty:
   - Answer ONLY using those results.
   - Under 3 sentences.
3) If results are empty:
   - If likely_in_scope is true: say exactly "${KB_MISSING_EXACT}"
   - If likely_in_scope is false: say exactly "${OUT_OF_SCOPE_EXACT}"
Do NOT add anything else.`,
              tool_choice: "none",
              output_modalities: ["audio"],
            },
          });

          return;
        }

        // transfer_to_human (still supported, but server-side transfer is primary)
        if (functionName === "transfer_to_human") {
          if (st) st.transferring = true;

          safeSendOpenAI({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify({ status: "transferring", to: TRANSFER_NUMBER }),
            },
          });

          await handleCallTransfer({ callSid, hostForCallbacks });

          try {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
          } catch {}
          try {
            if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
          } catch {}

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

        const st = getOrCreateState(streamSid);
        if (st) st.callSid = callSid;

        fastify.log.info({ streamSid, callSid }, "Incoming stream started");
        return;
      }

      if (data.event === "media") {
        const st = getOrCreateState(streamSid);
        if (st?.transferring) return;

        if (openAiWs.readyState === WebSocket.OPEN) {
          safeSendOpenAI({ type: "input_audio_buffer.append", audio: data.media.payload });
        }
        return;
      }

      if (data.event === "stop") {
        fastify.log.info({ streamSid }, "Received stop event from Twilio.");
        finalizeCall(streamSid);
        return;
      }
    });

    twilioWs.on("close", () => {
      fastify.log.info({ streamSid }, "Client disconnected (Twilio WS).");
      finalizeCall(streamSid);
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
