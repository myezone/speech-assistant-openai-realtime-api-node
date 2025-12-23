/**
 * index.js — Twilio Media Streams ↔ OpenAI Realtime (voice-to-voice)
 *          + Vector Store kb_search tool
 *
 * What changed from your current file:
 *  - Greeting + behavior moved to OpenAI Prompt (OPENAI_PROMPT_ID)
 *  - Removed SYSTEM_MESSAGE from code
 *  - Removed <Say> greeting from TwiML (OpenAI greets first)
 *  - session.update uses prompt: { id: OPENAI_PROMPT_ID }
 *  - Triggers response.create once after session.updated (to speak first)
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
  TEMPERATURE,
  PORT,
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

// Twilio audio is 8k mu-law; Realtime uses "audio/pcmu" (G.711 mu-law)
const REALTIME_MODEL = "gpt-realtime";
const DEFAULT_VOICE = VOICE || "alloy";
const DEFAULT_TEMPERATURE = Number.isFinite(Number(TEMPERATURE)) ? Number(TEMPERATURE) : 0.8;
const LISTEN_PORT = PORT || 10000;

// Keep logs readable
const LOG_EVENT_TYPES = new Set([
  "error",
  "session.created",
  "session.updated",
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.committed",
  "response.created",
  "response.output_item.done",
  "response.done",
  "rate_limits.updated",
]);

fastify.get("/", async (_request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
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
// Greeting is NOT here anymore — OpenAI will greet first via your Prompt.
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
        // IMPORTANT: do NOT include ranking_options.rewrite_query (your logs showed it can be rejected)
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
      // Vector store results often have content[] segments with text
      const contentArr = Array.isArray(r?.content) ? r.content : [];
      const textJoined = contentArr
        .map((c) => {
          const t = c?.text;
          if (typeof t === "string") return t;
          // some shapes may be { text: { value: "..." } }
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
    let latestMediaTimestamp = 0;

    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // ordering / concurrency
    let responseInFlight = false;
    let queuedResponseCreate = false;
    let greetedThisCall = false;

    const handledToolCalls = new Set();

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      }
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
      // Voice-to-voice ONLY — do NOT include input_audio_transcription.
      safeSendOpenAI({
        type: "session.update",
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          output_modalities: ["audio"],

          // Keep formats aligned with Twilio (8k mu-law)
          audio: {
            input: {
              format: { type: "audio/pcmu", rate: 8000 },
              turn_detection: { type: "server_vad" },
            },
            output: {
              format: { type: "audio/pcmu" },
              voice: DEFAULT_VOICE,
            },
          },

          // ✅ Move all greetings + behavior into OpenAI Prompt
          prompt: {
            id: OPENAI_PROMPT_ID,
          },

          // you can control creativity here (or set in Prompt if you prefer)
          temperature: DEFAULT_TEMPERATURE,

          // ✅ Tool the model can call; server executes Vector Store search
          tools: [
            {
              type: "function",
              name: "kb_search",
              description:
                "Search the CallsAnswered.ai knowledge base and return relevant passages. Use this before answering factual questions.",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
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

    const handleSpeechStartedEvent = () => {
      // Barge-in: stop assistant audio and cancel in-flight response
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedMs = latestMediaTimestamp - responseStartTimestampTwilio;

        if (lastAssistantItem) {
          safeSendOpenAI({
            type: "conversation.item.truncate",
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: Math.max(0, elapsedMs),
          });
        }

        if (responseInFlight) {
          safeSendOpenAI({ type: "response.cancel" });
          responseInFlight = false;
          queuedResponseCreate = false;
        }

        if (streamSid) connection.send(JSON.stringify({ event: "clear", streamSid }));

        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
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

        if (LOG_EVENT_TYPES.has(evt.type)) {
          fastify.log.info(
            { type: evt.type, response_id: evt.response_id, event_id: evt.event_id },
            "OpenAI event"
          );
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

        // ✅ Speak first: once session is updated, trigger a response (greeting comes from Prompt)
        if (evt.type === "session.updated" && !greetedThisCall) {
          greetedThisCall = true;
          requestResponseCreate("initial_greeting");
        }

        // ✅ Forward audio to Twilio — handle BOTH event names
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

          if (!responseStartTimestampTwilio) responseStartTimestampTwilio = latestMediaTimestamp;
          if (evt.item_id) lastAssistantItem = evt.item_id;
          sendMark();
        }

        // Barge-in
        if (evt.type === "input_audio_buffer.speech_started") {
          handleSpeechStartedEvent();
        }

        // Tool calls come through response.output_item.done
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
            } catch {}

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
                output: JSON.stringify({
                  query,
                  passages,
                }),
              },
            });

            // Ensure the model continues after tool output
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
            fastify.log.info({ streamSid }, "Incoming stream started");

            latestMediaTimestamp = 0;
            responseStartTimestampTwilio = null;
            lastAssistantItem = null;
            markQueue = [];
            responseInFlight = false;
            queuedResponseCreate = false;
            greetedThisCall = false;
            handledToolCalls.clear();
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
