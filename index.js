/**
 * index.js — Twilio Media Streams ↔ OpenAI Realtime
 * + Postgres logging (calls + call_utterances)
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
  VECTOR_STORE_ID,
  PORT,
  VOICE,
  OPENAI_TRANSCRIPTION_MODEL,
  MAX_TRANSCRIPTS,
  PUBLIC_HOST,
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!OPENAI_PROMPT_ID) throw new Error("Missing OPENAI_PROMPT_ID");
if (!VECTOR_STORE_ID) throw new Error("Missing VECTOR_STORE_ID");

const fastify = Fastify({ logger: true });
await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

const LISTEN_PORT = Number(PORT) || 10000;
const REALTIME_MODEL = "gpt-realtime";
const DEFAULT_VOICE = VOICE || "marin";
const TRANSCRIPTION_MODEL = OPENAI_TRANSCRIPTION_MODEL || "whisper-1";
const RETAIN_MAX = Math.max(1, Math.min(500, Number(MAX_TRANSCRIPTS) || 50));

/** DB write for each turn (non-blocking) */
function persistTurn(rec, role, text) {
  const callSid = rec?.callSid;
  if (!callSid) return;

  const dbRole = role === "user" ? "caller" : "agent";

  void logUtterance({ callId: callSid, role: dbRole, text }).catch((e) => {
    fastify.log.error({ callSid, err: String(e) }, "logUtterance failed");
  });
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

  // write to DB
  persistTurn(rec, role, clean);
}

/** Persist summary + fallback duration once at end of call */
function finalizeCallIfPossible(streamSid, fallbackCallSid = null) {
  const rec = streamSid ? transcriptsByStreamSid.get(streamSid) : null;
  if (!rec) return;

  if (!rec.endedAt) {
    rec.endedAt = Date.now();
    rec.durationMs = rec.endedAt - rec.startedAt;
  }

  rec.callSid = rec.callSid || fallbackCallSid || null;
  const callSid = rec.callSid;

  if (!callSid || rec.summarySaved) return;
  rec.summarySaved = true;

  const turns = rec.turns?.length || 0;
  const durationSeconds = Math.max(0, Math.round((rec.durationMs || 0) / 1000));

  // simple summary text
  const firstUser = rec.turns.find((t) => t.role === "user")?.text || "";
  const lastAgent = [...rec.turns].reverse().find((t) => t.role === "assistant")?.text || "";
  const summaryText =
    `Caller: ${firstUser}`.slice(0, 400) +
    (lastAgent ? ` | Agent: ${lastAgent}`.slice(0, 400) : "");

  fastify.log.info({ streamSid, callSid, durationMs: rec.durationMs, turns }, "CALL TRANSCRIPT SUMMARY");

  void setCallDurationFallback({ callId: callSid, durationSeconds }).catch((e) => {
    fastify.log.error({ callSid, err: String(e) }, "setCallDurationFallback failed");
  });

  void saveCallSummary({
    callId: callSid,
    summaryText: summaryText || `Call ended. Turns: ${turns}. Duration: ${durationSeconds}s.`,
    summaryJson: { turns, durationMs: rec.durationMs, durationSeconds },
  }).catch((e) => {
    fastify.log.error({ callSid, err: String(e) }, "saveCallSummary failed");
  });
}


/** -----------------------------
 * In-memory transcript store
 * ----------------------------- */
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
      callSid: null, // Twilio CallSid (CA...)
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      turns: [], // { role: 'user'|'assistant', text, ts }
      summarySaved: false,
    };
    transcriptsByStreamSid.set(streamSid, rec);
    transcriptOrder.push(streamSid);
    latestStreamSid = streamSid;
    retainIfNeeded();
  }
  return rec;
}

/** ✅ DB write for each turn (non-blocking) */
function persistTurn(rec, role, text) {
  const callSid = rec?.callSid;
  if (!callSid) return;

  const dbRole = role === "user" ? "caller" : "agent";

  void logUtterance({ callId: callSid, role: dbRole, text }).catch((e) => {
    fastify.log.error({ callSid, err: String(e) }, "logUtterance failed");
  });
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

  // ✅ write to DB
  persistTurn(rec, role, clean);
}

/** ✅ Persist summary + fallback duration once at end of call */
function finalizeCallIfPossible(streamSid, fallbackCallSid = null) {
  const rec = streamSid ? transcriptsByStreamSid.get(streamSid) : null;
  if (!rec) return;

  if (!rec.endedAt) {
    rec.endedAt = Date.now();
    rec.durationMs = rec.endedAt - rec.startedAt;
  }

  rec.callSid = rec.callSid || fallbackCallSid || null;
  const callSid = rec.callSid;

  if (!callSid || rec.summarySaved) return;
  rec.summarySaved = true;

  const turns = rec.turns?.length || 0;
  const durationSeconds = Math.max(0, Math.round((rec.durationMs || 0) / 1000));

  // simple summary text (you can upgrade later to LLM summary)
  const firstUser = rec.turns.find((t) => t.role === "user")?.text || "";
  const lastAgent = [...rec.turns].reverse().find((t) => t.role === "assistant")?.text || "";
  const summaryText =
    `Caller: ${firstUser}`.slice(0, 400) +
    (lastAgent ? ` | Agent: ${lastAgent}`.slice(0, 400) : "");

  fastify.log.info({ streamSid, callSid, durationMs: rec.durationMs, turns }, "CALL TRANSCRIPT SUMMARY");

  void setCallDurationFallback({ callId: callSid, durationSeconds }).catch((e) => {
    fastify.log.error({ callSid, err: String(e) }, "setCallDurationFallback failed");
  });

  void saveCallSummary({
    callId: callSid,
    summaryText: summaryText || `Call ended. Turns: ${turns}. Duration: ${durationSeconds}s.`,
    summaryJson: { turns, durationMs: rec.durationMs, durationSeconds },
  }).catch((e) => {
    fastify.log.error({ callSid, err: String(e) }, "saveCallSummary failed");
  });
}

/** -----------------------------
 * Basic routes
 * ----------------------------- */
fastify.get("/", async (_req, reply) => reply.send({ ok: true, service: "Voice IVA" }));

fastify.get("/transcripts/latest", async (_req, reply) => {
  if (!latestStreamSid) return reply.code(404).send({ error: "No transcripts yet." });
  const rec = transcriptsByStreamSid.get(latestStreamSid);
  if (!rec) return reply.code(404).send({ error: "No transcripts yet." });
  return reply.send(rec);
});

/** -----------------------------
 * Twilio webhook: incoming call -> TwiML Stream
 * ----------------------------- */
fastify.all("/incoming-call", async (request, reply) => {
  const callId = request.body?.CallSid || request.query?.CallSid || null;
  const from = request.body?.From || request.query?.From || null;
  const to = request.body?.To || request.query?.To || null;

  try {
    fastify.log.info({ callId, from, to }, "✅ /incoming-call HIT");
    if (callId) {
      await upsertCallStart({ callId, from, to });
      fastify.log.info({ callId }, "✅ DB INSERT OK (call start)");
    }
  } catch (err) {
    fastify.log.error({ err: String(err), callId }, "❌ DB INSERT FAILED (call start)");
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
 * Twilio status callback (optional but good)
 * ----------------------------- */
fastify.post("/twilio/call-status", async (req, reply) => {
  try {
    const callId = req.body?.CallSid;
    const callStatus = req.body?.CallStatus;
    const callDuration = Number(req.body?.CallDuration || 0);

    if (callStatus === "completed") {
      await setOfficialCallDuration({
        callId,
        durationSeconds: callDuration,
        status: callStatus,
      });
      fastify.log.info({ callId, callDuration }, "✅ Official duration saved (Twilio completed)");
    }
  } catch (err) {
    fastify.log.error({ err: String(err) }, "❌ /twilio/call-status failed");
  }

  return reply.code(200).send("ok");
});

/** -----------------------------
 * OpenAI vector store search
 * ----------------------------- */
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
        .map((c) => (typeof c?.text === "string" ? c.text : c?.text?.value || ""))
        .filter(Boolean)
        .join("\n\n")
        .trim();
      return text;
    })
    .filter(Boolean);

  return passages.join("\n---\n");
}

/** -----------------------------
 * WebSocket: Twilio ↔ OpenAI Realtime
 * ----------------------------- */
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection) => {
    fastify.log.info("Client connected (Twilio WS)");

    let streamSid = null;
    let callSid = null;

    const userTranscriptBufferByItem = new Map();
    const assistantTranscriptBufferByResp = new Map();
    const handledToolCalls = new Set();

    const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
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
          type: "realtime",
          model: REALTIME_MODEL,
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "g711_ulaw" },
              turn_detection: { type: "server_vad" },
              transcription: { model: TRANSCRIPTION_MODEL },
            },
            output: { format: { type: "g711_ulaw" }, voice: DEFAULT_VOICE },
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

      // greet
      safeSendOpenAI({ type: "response.create" });
    };

    openAiWs.on("open", () => {
      fastify.log.info("Connected to OpenAI Realtime");
      setTimeout(initializeSession, 50);
    });

    openAiWs.on("message", async (raw) => {
      try {
        const evt = JSON.parse(raw);

        // Caller transcript deltas/completed
        if (evt.type === "conversation.item.input_audio_transcription.delta") {
          const itemId = evt.item_id;
          const prev = userTranscriptBufferByItem.get(itemId) || "";
          userTranscriptBufferByItem.set(itemId, prev + (evt.delta || ""));
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
          const prev = assistantTranscriptBufferByResp.get(rid) || "";
          assistantTranscriptBufferByResp.set(rid, prev + (evt.delta || ""));
          return;
        }

        if (evt.type === "response.output_audio_transcript.done") {
          const rid = evt.response_id;
          const finalText = (evt.transcript || assistantTranscriptBufferByResp.get(rid) || "").trim();
          assistantTranscriptBufferByResp.delete(rid);
          if (finalText) addTurn(streamSid, "assistant", finalText);
          return;
        }

        // Tool call: kb_search
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
          } catch (e) {
            fastify.log.error({ err: String(e), streamSid }, "KB search failed");
          }

          safeSendOpenAI({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: fc.call_id, output: JSON.stringify({ query, passages }) },
          });

          safeSendOpenAI({ type: "response.create" });
        }
      } catch (e) {
        fastify.log.error({ err: String(e) }, "Error processing OpenAI event");
      }
    });

    connection.on("message", (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.event === "start") {
          streamSid = data.start.streamSid;
          callSid = data.start.callSid || null;

          const rec = getOrCreateTranscript(streamSid);
          if (rec) rec.callSid = callSid;

          fastify.log.info({ streamSid, callSid }, "Incoming stream started");
          return;
        }

        if (data.event === "media") {
          if (openAiWs.readyState === WebSocket.OPEN) {
            safeSendOpenAI({ type: "input_audio_buffer.append", audio: data.media.payload });
          }
          return;
        }

        if (data.event === "stop") {
          fastify.log.info({ streamSid }, "Received stop event from Twilio.");
          finalizeCallIfPossible(streamSid, callSid);
          return;
        }
      } catch (e) {
        fastify.log.error({ err: String(e) }, "Error parsing Twilio message");
      }
    });

    connection.on("close", () => {
      fastify.log.info({ streamSid }, "Client disconnected (Twilio WS).");
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
  fastify.log.info(`Server is listening on port ${LISTEN_PORT}`);
});
