import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY, VECTOR_STORE_ID } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set OPENAI_API_KEY in Render Environment variables.');
    process.exit(1);
}

if (!VECTOR_STORE_ID) {
    console.error('Missing VECTOR_STORE_ID. Please set VECTOR_STORE_ID in Render Environment variables.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE =
    "You are a phone support agent for CallsAnswered.ai. " +
    "You MUST answer using ONLY the information returned by the kb_search tool. " +
    "Before answering any user question, call kb_search with a short query. " +
    "If the tool returns no relevant information, say: 'I don’t have that information in the knowledge base.' " +
    "Do not use outside knowledge. Do not guess.";

const VOICE = 'alloy';
const TEMPERATURE = 0.8; // Controls the randomness of the AI's responses
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'response.output_item.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'session.updated'
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">Please wait while we connect your call to the A. I. voice assistant, powered by Twilio and the Open A I Realtime API</Say>
  <Pause length="1"/>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">O.K. you can start talking!</Say>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream" />
  </Connect>
</Response>`;

    reply.type('text/xml').send(twimlResponse);
});

async function searchKb(query) {
    const resp = await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/search`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
            // Vector store endpoints typically require this:
            'OpenAI-Beta': 'assistants=v2'
        },
        body: JSON.stringify({
            query,
            max_num_results: 5,
            ranking_options: { rewrite_query: true }
        })
    });

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`KB search failed: ${resp.status} ${errText}`);
    }
    return resp.json();
}

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampT

