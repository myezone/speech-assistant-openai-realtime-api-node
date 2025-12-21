import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { OPENAI_API_KEY, VECTOR_STORE_ID } = process.env;

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment variables.');
  process.exit(1);
}
if (!VECTOR_STORE_ID) {
  console.error('Missing VECTOR_STORE_ID in environment variables.');
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE =
  "You are a phone support agent for CallsAnswered.ai. " +
  "You MUST answer using ONLY the information returned by the kb_search tool. " +
  "Before answering any user question, call kb_search with a short query. " +
  "If the tool returns no relevant information, say: 'I don’t have that information in the knowledge base.' " +
  "Do not use outside knowledge. Do not guess.";

const VOICE = 'alloy';
const TEMPERATURE = 0.8;
const PORT = process.env.PORT || 5050;

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

fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Twilio Media Stream Server is running!' });
});

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

fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Client connected');

    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`,
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    const initializeSession = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          type: 'realtime',
          model: 'gpt-realtime',
          output_modalities: ['audio'],
          audio: {
            input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' } },
            output: { format: { type: 'audio/pcmu' }, voice: VOICE }
          },
          instructions: SYSTEM_MESSAGE,
          tools: [
            {
              type: 'function',
              name: 'kb_search',
              description: 'Search the CallsAnswered.ai knowledge base and return relevant passages.',
              parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query']
              }
            }
          ],
          tool_choice: 'auto'
        }
      };
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    const sendMark = () => {
      if (!streamSid) return;
      connection.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } }));
      markQueue.push('responsePart');
    };

    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;

        if (lastAssistantItem) {
          openAiWs.send(JSON.stringify({
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime
          }));
        }

        connection.send(JSON.stringify({ event: 'clear', streamSid }));

        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    openAiWs.on('open', () => {
      console.log('Connected to the OpenAI Realtime API');
      setTimeout(initializeSession, 100);
    });

    openAiWs.on('message', async (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }

        if (response.type === 'response.output_audio.delta' && response.delta) {
          connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: response.delta } }));

          if (!responseStartTimestampTwilio) responseStartTimestampTwilio = latestMediaTimestamp;
          if (response.item_id) lastAssistantItem = response.item_id;

          sendMark();
        }

        if (response.type === 'input_audio_buffer.speech_started') {
          handleSpeechStartedEvent();
        }

        let functionCall = null;
        if (response.type === 'response.output_item.done' && response.item?.type === 'function_call') {
          functionCall = response.item;
        }
        if (!functionCall && response.type === 'response.done') {
          const outs = response.response?.output || [];
          functionCall = outs.find((o) => o?.type === 'function_call' && o?.name === 'kb_search') || null;
        }

        if (functionCall && functionCall.name === 'kb_search' && functionCall.call_id) {
          const callId = functionCall.call_id;

          const rawArgs = functionCall.arguments ?? functionCall.arguments_json ?? '{}';
          let args;
          try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs; } catch { args = {}; }

          const query = (args?.query || '').toString().trim();

          let kbJson;
          try { kbJson = await searchKb(query); } catch (e) { kbJson = { error: String(e) }; }

          const results = kbJson?.data || kbJson?.results || kbJson?.matches || [];
          const passages = Array.isArray(results)
            ? results.slice(0, 5).map(r => r?.content?.[0]?.text || r?.text || r?.document?.text || r?.document || '')
              .filter(Boolean).join('\n---\n')
            : '';

          openAiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify({ query, passages })
            }
          }));

          openAiWs.send(JSON.stringify({ type: 'response.create' }));
        }
      } catch (err) {
        console.error('Error processing OpenAI message:', err);
      }
    });

    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'media':
            latestMediaTimestamp = data.media.timestamp;
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
            }
            break;

          case 'start':
            streamSid = data.start.streamSid;
            console.log('Incoming stream started', streamSid);
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
            break;

          case 'mark':
            if (markQueue.length > 0) markQueue.shift();
            break;

          case 'stop':
            console.log('Received stop event from Twilio.');
            break;

          default:
            console.log('Received non-media event:', data.event);
        }
      } catch (err) {
        console.error('Error parsing Twilio message:', err);
      }
    });

    connection.on('close', () => {
      console.log('Client disconnected.');
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    });

    openAiWs.on('close', () => console.log('Disconnected from OpenAI Realtime API'));
    openAiWs.on('error', (e) => console.error('OpenAI WS error:', e));
  });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});
