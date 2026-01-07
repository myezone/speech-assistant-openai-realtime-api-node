/**
 * index.js — Twilio Media Streams ↔ OpenAI Realtime API (Production Version)
 * 
 * Architecture:
 * 1. Greets customer FIRST in Twilio media stream
 * 2. After greeting, OpenAI listens and ONLY answers from knowledge base
 * 3. Strict KB-only restriction - never answers from general knowledge
 * 
 * Based on:
 * - OpenAI Realtime API GA (gpt-realtime model)
 * - Twilio Media Streams WebSocket API
 * - Production best practices as of January 2026
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
  VECTOR_STORE_ID,
  PORT,
  VOICE,
  OPENAI_TRANSCRIPTION_MODEL,
  PUBLIC_HOST,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  LOG_LEVEL,
  GREETING_TEXT,
} = process.env;

// Required environment variables
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!TWILIO_ACCOUNT_SID) throw new Error("Missing TWILIO_ACCOUNT_SID");
if (!TWILIO_AUTH_TOKEN) throw new Error("Missing TWILIO_AUTH_TOKEN");

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const fastify = Fastify({
  logger: {
    level: LOG_LEVEL || "info",
  },
});

await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

// Configuration constants
const LISTEN_PORT = Number(PORT) || 10000;
const REALTIME_MODEL = "gpt-realtime"; // Latest GA model
const DEFAULT_VOICE = VOICE || "marin"; // Marin is one of the new high-quality voices
const TRANSCRIPTION_MODEL = OPENAI_TRANSCRIPTION_MODEL || "whisper-1";
const TRANSFER_NUMBER = "+14026171324";
const DEFAULT_GREETING = GREETING_TEXT || "Thank you for calling. How may I help you today?";

// System instructions for KB-only responses
const KB_ONLY_INSTRUCTIONS = `You are a voice assistant that ONLY answers questions from the knowledge base.

CRITICAL RESTRICTIONS:
1. You can ONLY answer questions using information from the knowledge base
2. You MUST use the kb_search function for EVERY question
3. If the knowledge base doesn't contain the answer, you MUST say: "I don't have that information in my knowledge base. Is there something else about our services I can help you with?"
4. You CANNOT answer questions from general knowledge, even if you know the answer
5. You CANNOT make up information or guess answers

REQUIRED WORKFLOW:
For every user question:
1. Use kb_search function with relevant keywords
2. Wait for search results
3. If results found: Answer using ONLY the information from search results
4. If no results: Say you don't have that information

EXAMPLE GOOD RESPONSES:
User: "What are your business hours?"
→ Use kb_search("business hours")
→ Answer from results only

User: "What's the weather today?"
→ Use kb_search("weather")
→ If no results: "I don't have that information in my knowledge base. Is there something else about our services I can help you with?"

EXAMPLE BAD RESPONSES (NEVER DO THIS):
User: "What are your business hours?"
→ "We're typically open 9-5..." ❌ WRONG - you guessed without searching

User: "What's the weather?"
→ "It's sunny today..." ❌ WRONG - you used general knowledge

Remember: When in doubt, search the knowledge base. If it's not there, admit it.`;

/** --------- Helper Functions --------- */

function normalizeHost(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const noProto = raw.replace(/^https?:\/\//i, "");
  const hostOnly = noProto.split("/")[0].trim();
  return hostOnly || null;
}

/**
 * Handle call transfer by updating the active call with new TwiML
 */
async function handleCallTransfer({ callSid, reason, hostForCallbacks }) {
  if (!callSid) {
    fastify.log.error("❌ Cannot transfer: callSid is null");
    return;
  }

  const callbackHost = normalizeHost(hostForCallbacks) || normalizeHost(PUBLIC_HOST);
  if (!callbackHost) {
    fastify.log.error(
      { callSid },
      "❌ Cannot transfer: PUBLIC_HOST is missing/invalid"
    );
    return;
  }

  try {
    fastify.log.info({ callSid, reason }, "📞 Transferring call");

    await twilioClient.calls(callSid).update({
      twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Let me connect you with someone who can help right away.</Say>
  <Dial timeout="30" action="https://${callbackHost}/call-transfer-status" method="POST">
    <Number>${TRANSFER_NUMBER}</Number>
  </Dial>
  <Say voice="alice">I'm sorry, no one is available right now. Please try again later.</Say>
</Response>`,
    });

    fastify.log.info({ callSid, to: TRANSFER_NUMBER }, "✅ Transfer initiated");
  } catch (error) {
    fastify.log.error(
      { callSid, err: error?.message || String(error) },
      "❌ Transfer failed"
    );
  }
}

/**
 * Handle knowledge base search using OpenAI Vector Store
 * This is called by the OpenAI model via function calling
 */
async function handleKbSearch(query) {
  try {
    const q = String(query || "").trim();
    fastify.log.info({ query: q }, "🔍 KB Search requested");

    if (!VECTOR_STORE_ID) {
      fastify.log.error("❌ VECTOR_STORE_ID not configured");
      return {
        success: false,
        results: [],
        error: "Knowledge base not configured",
      };
    }

    // Call OpenAI Vector Store API to search
    const response = await fetch(
      `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: q,
          top_k: 5,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Vector store search failed: ${response.statusText}`);
    }

    const data = await response.json();
    const results = data.data || [];

    fastify.log.info(
      { query: q, resultCount: results.length },
      "✅ KB Search completed"
    );

    return {
      success: true,
      results: results.map((r) => ({
        content: r.content || r.text || "",
        score: r.score || 0,
      })),
    };
  } catch (error) {
    fastify.log.error({ error: error.message }, "❌ KB Search error");
    return {
      success: false,
      error: error.message,
      results: [],
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

/** --------- Call State Management --------- */
const callStateByStreamSid = new Map();

function getOrCreateState(streamSid) {
  if (!streamSid) return null;
  let st = callStateByStreamSid.get(streamSid);
  if (!st) {
    st = {
      callSid: null,
      startedAt: Date.now(),
      turns: [],
      greetingPlayed: false,
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
  const lastAgent = [...st.turns]
    .reverse()
    .find((t) => t.role === "assistant")?.text || "";
  const summaryText =
    `Caller: ${firstUser}`.slice(0, 400) +
    (lastAgent ? ` | Agent: ${lastAgent}`.slice(0, 400) : "");

  void setCallDurationFallback({ callId: st.callSid, durationSeconds }).catch(() => {});
  void saveCallSummary({
    callId: st.callSid,
    summaryText: summaryText || `Call ended. Turns: ${turns}. Duration: ${durationSeconds}s.`,
    summaryJson: { turns, durationMs, durationSeconds },
  }).catch(() => {});

  callStateByStreamSid.delete(streamSid);
}

/** -----------------------------
 * HTTP Routes
 * ----------------------------- */

fastify.get("/", async (_req, reply) => reply.send({ ok: true }));

/**
 * Twilio webhook: incoming call -> TwiML Stream
 */
fastify.all("/incoming-call", async (request, reply) => {
  const callId = request.body?.CallSid || request.query?.CallSid || null;
  const from = request.body?.From || request.query?.From || null;
  const to = request.body?.To || request.query?.To || null;

  if (callId) {
    try {
      await upsertCallStart({ callId, from, to });
    } catch (err) {
      fastify.log.error({ err }, "Failed to log call start");
    }
  }

  const host =
    normalizeHost(PUBLIC_HOST) ||
    normalizeHost(request.headers["x-forwarded-host"]) ||
    normalizeHost(request.headers.host);

  if (!host) {
    reply.code(500).send("Missing PUBLIC_HOST or request host");
    return;
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;

  reply.code(200).type("text/xml").send(twiml);
});

/**
 * Twilio status callback
 */
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
  } catch (err) {
    fastify.log.error({ err }, "Error in call status callback");
  }

  return reply.code(200).send("ok");
});

/**
 * Call transfer status callback
 */
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
      fastify.log.info(
        { callSid, duration: dialCallDuration },
        "✅ Transfer successful"
      );
    } else if (dialCallStatus === "no-answer" || dialCallStatus === "busy") {
      fastify.log.info({ callSid }, "⚠️ Transfer not answered/busy");
    } else if (dialCallStatus === "failed") {
      fastify.log.error({ callSid }, "❌ Transfer failed");
    }
  } catch (error) {
    fastify.log.error({ error: error.message }, "❌ Error in transfer status");
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
        url: req.url,
        headers: {
          upgrade: req.headers.upgrade,
          connection: req.headers.connection,
        },
      },
      "✅ Twilio WebSocket connected"
    );

    const hostForCallbacks =
      normalizeHost(PUBLIC_HOST) ||
      normalizeHost(req.headers["x-forwarded-host"]) ||
      normalizeHost(req.headers.host);

    let streamSid = null;
    let callSid = null;

    const assistantTranscriptBufferByResp = new Map();
    const handledToolCalls = new Set();

    let sessionConfigured = false;
    let greetingPlayed = false;
    let transferring = false;

    // Connect to OpenAI Realtime API via WebSocket
    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1", // Required for API compatibility
        },
      }
    );

    openAiWs.on("error", (err) => {
      fastify.log.error({ err: String(err) }, "❌ OpenAI WebSocket error");
    });

    openAiWs.on("close", (code, reason) => {
      fastify.log.warn(
        { code, reason: reason?.toString?.() },
        "⚠️ OpenAI WebSocket closed"
      );
    });

    const safeSendOpenAI = (obj) => {
      if (openAiWs.readyState !== WebSocket.OPEN) {
        fastify.log.warn(
          { event: obj.type },
          "⚠️ Cannot send to OpenAI - WebSocket not open"
        );
        return false;
      }
      openAiWs.send(JSON.stringify(obj));
      return true;
    };

    /**
     * Initialize OpenAI session with KB-only configuration
     * - Disables turn detection initially (so greeting plays first)
     * - Sets strict KB-only instructions
     * - Configures audio format for Twilio compatibility
     */
    const initializeSession = () => {
      const sessionConfig = {
        type: "session.update",
        session: {
          type: "realtime", // Required in GA API
          model: REALTIME_MODEL,

          // Audio-only output for phone experience
          output_modalities: ["audio"],

          audio: {
            input: {
              // Twilio Media Streams uses 8kHz mu-law (g711_ulaw)
              format: { type: "audio/g711_ulaw" },

              // Enable transcription for logging
              transcription: {
                model: TRANSCRIPTION_MODEL,
                language: "en",
              },

              // DISABLE turn detection initially - we'll enable after greeting
              turn_detection: null,
            },

            output: {
              // Twilio expects mu-law format
              format: { type: "audio/g711_ulaw" },
              voice: DEFAULT_VOICE,
            },
          },

          // Use stored prompt if provided, otherwise use inline instructions
          ...(OPENAI_PROMPT_ID
            ? {
                prompt: {
                  id: OPENAI_PROMPT_ID,
                  // DO NOT pin version - always use latest
                },
              }
            : {
                instructions: KB_ONLY_INSTRUCTIONS,
              }),

          // Define available functions
          tools: [
            {
              type: "function",
              name: "kb_search",
              description:
                "Search the knowledge base for information. REQUIRED for answering ANY user question.",
              parameters: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description: "Search query with 2-8 keywords",
                  },
                },
                required: ["query"],
              },
            },
            {
              type: "function",
              name: "transfer_to_human",
              description:
                "Transfer the call to a human representative immediately",
              parameters: {
                type: "object",
                properties: {
                  reason: {
                    type: "string",
                    description: "Reason for transfer",
                  },
                },
                required: ["reason"],
              },
            },
          ],

          tool_choice: "auto", // Allow model to choose when to use tools
        },
      };

      fastify.log.info("📋 Sending session configuration to OpenAI");
      safeSendOpenAI(sessionConfig);
    };

    /**
     * Play greeting and then enable turn detection
     * This ensures greeting plays BEFORE user can speak
     */
    const playGreetingAndEnableListening = () => {
      if (greetingPlayed) return;
      greetingPlayed = true;

      fastify.log.info("👋 Playing greeting to caller");

      // Create a manual response with greeting text
      safeSendOpenAI({
        type: "response.create",
        response: {
          // Generate audio from this text
          output_modalities: ["audio"],
          instructions: `Say exactly this greeting: "${DEFAULT_GREETING}"`,
        },
      });

      // After greeting completes, we'll enable turn detection
      // (handled in response.done event)
    };

    /**
     * Enable turn detection so AI starts listening to user
     */
    const enableTurnDetection = () => {
      fastify.log.info("🎤 Enabling turn detection - AI now listening");

      safeSendOpenAI({
        type: "session.update",
        session: {
          type: "realtime",
          audio: {
            input: {
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
                interrupt_response: true,
                create_response: true,
                idle_timeout_ms: 15000,
              },
            },
          },
        },
      });
    };

    openAiWs.on("open", () => {
      fastify.log.info("✅ Connected to OpenAI Realtime API");
      // Initialize session configuration immediately
      setTimeout(initializeSession, 100);
    });

    openAiWs.on("message", async (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw);
      } catch (e) {
        fastify.log.error({ err: String(e) }, "❌ OpenAI JSON parse error");
        return;
      }

      // Always log errors
      if (evt.type === "error") {
        fastify.log.error({ evt }, "❌ OpenAI error event");
        return;
      }

      // Session configured - play greeting
      if (evt.type === "session.created" || evt.type === "session.updated") {
        if (!sessionConfigured) {
          sessionConfigured = true;
          fastify.log.info(
            { model: evt.session?.model, voice: evt.session?.audio?.output?.voice },
            "✅ Session configured"
          );
          // Play greeting after session is ready
          setTimeout(() => playGreetingAndEnableListening(), 200);
        }
        return;
      }

      // Greeting response completed - enable turn detection
      if (evt.type === "response.done") {
        if (greetingPlayed && !transferring) {
          const st = getOrCreateState(streamSid);
          if (st && !st.greetingPlayed) {
            st.greetingPlayed = true;
            fastify.log.info("✅ Greeting completed");
            // Enable turn detection so user can now speak
            setTimeout(enableTurnDetection, 100);
          }
        }
        return;
      }

      // Stop processing if transferring
      if (transferring) return;

      // Handle audio output -> send to Twilio
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

      // Handle user transcription
      if (evt.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = evt.transcript || "";
        if (transcript) {
          fastify.log.info({ transcript }, "👤 User said");
          addTurn(streamSid, "user", transcript);
        }
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
          fastify.log.info({ transcript: full }, "🤖 Assistant said");
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
          args = JSON.parse(evt.arguments || "{}");
        } catch {
          args = {};
        }

        fastify.log.info(
          { functionName, args, callId },
          "🔧 Function call received"
        );

        // Handle kb_search function
        if (functionName === "kb_search") {
          const result = await handleKbSearch(args.query);

          // Send search results back to model
          safeSendOpenAI({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify(result),
            },
          });

          // Instruct model to continue with KB-only response
          safeSendOpenAI({
            type: "response.create",
            response: {
              instructions:
                "Answer using ONLY the information from the kb_search results. If results are empty, say you don't have that information in your knowledge base.",
            },
          });
          return;
        }

        // Handle transfer_to_human function
        if (functionName === "transfer_to_human") {
          transferring = true;
          fastify.log.info(
            { callSid, reason: args.reason },
            "📞 Initiating transfer"
          );

          // Acknowledge tool execution
          safeSendOpenAI({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify({
                status: "transferring",
                to: TRANSFER_NUMBER,
              }),
            },
          });

          // Execute transfer
          await handleCallTransfer({
            callSid,
            reason: args.reason || "requested_human",
            hostForCallbacks,
          });

          // Close connections
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

    // Handle Twilio WebSocket messages
    twilioWs.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg);
      } catch (e) {
        fastify.log.error({ err: String(e) }, "❌ Twilio JSON parse error");
        return;
      }

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        callSid = data.start.callSid || null;

        // Store callSid in state for logging
        const st = getOrCreateState(streamSid);
        if (st) st.callSid = callSid;

        fastify.log.info({ streamSid, callSid }, "✅ Stream started");
        return;
      }

      if (data.event === "media") {
        // Only forward audio to OpenAI after greeting is played
        if (!transferring && greetingPlayed && openAiWs.readyState === WebSocket.OPEN) {
          // Forward Twilio audio to OpenAI
          safeSendOpenAI({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          });
        }
        return;
      }

      if (data.event === "stop") {
        fastify.log.info({ streamSid }, "🛑 Stream stopped");
        finalizeCallIfPossible(streamSid, callSid);
        return;
      }
    });

    twilioWs.on("close", () => {
      fastify.log.info({ streamSid }, "👋 Twilio WebSocket closed");
      finalizeCallIfPossible(streamSid, callSid);
      try {
        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      } catch {}
    });
  });
});

/** -----------------------------
 * Start Server
 * ----------------------------- */
fastify.listen({ port: LISTEN_PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server listening on port ${LISTEN_PORT}`);
  console.log(`📋 Model: ${REALTIME_MODEL}`);
  console.log(`🎤 Voice: ${DEFAULT_VOICE}`);
  console.log(`👋 Greeting: "${DEFAULT_GREETING}"`);
  console.log(`📚 KB-Only Mode: ${OPENAI_PROMPT_ID ? "Using stored prompt" : "Using inline instructions"}`);
});
