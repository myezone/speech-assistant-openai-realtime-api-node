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
 *  - VOICE (default "alloy")
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
  if (!re
