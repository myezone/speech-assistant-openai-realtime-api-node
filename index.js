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

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE =
  "You are a phone support agent for CallsAnswered.ai. " +
  "You MUST answer using ONLY the information returned by the kb_search tool. " +
  "Before answering any user question, call kb_search with a short query. " +
  "If the tool returns no relevant information, say: 'I don’t have that information in the knowledge base.' " +
  "Do not use outside knowledge. Do not guess.";

const VOICE = 'marin';
const TEMPERATURE = 0.8;
const PORT = process.env.PORT || 5050;

const LOG_EVENT_TYPES = [
  'error',
  'response.created',
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

// Optional: Verify vector store is populated (helps debug "no KB results")
fastify.get('/kb-status', async (request, reply) => {
  try {
    const resp = await fetch(`https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'assistants=v2'
      }
    });
    const json = await resp.json();
    reply.code(resp.status).send(json);
  } catch (e) {
    reply.code(500).send({ error: String(e) });
  }
});

fastify.all('/incoming-call', async (request, reply) => {
  const host = request.headers['x-forwarded-host'] || request.headers.host;
  fastify.log.info({ host }, 'Twilio incoming-call host');

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">Thank you for calling CallsAnswered dot AI</Say>
  <Pause length="1"/>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">How can I help you?</Say>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;

  reply.code(200).type('text/xml').send(twimlResponse);
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

  fastify.log.info({ query }, 'KB search query');
  return resp.json();
}

fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    fastify.log.info('Client connected (Twilio WS)');

    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // ---- Realtime response concurrency control ----
    let responseInFlight = false;
    let queuedResponseCreate = false;
    let activeResponseId = null;
    const handledToolCalls = new Set();

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`,
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    const safeSendOpenAI = (obj) => {
      if (openAiWs.readyState !== WebSocket.OPEN) return false;
      openAiWs.send(JSON.stringify(obj));
      return true;
    };

    const requestResponseCreate = (reason = '') => {
      if (responseInFlight) {
        queuedResponseCreate = true;
        return;
      }
      responseInFlight = true;
      safeSendOpenAI({ type: 'response.create' });
      if (reason) fastify.log.info({ reason }, 'Sent response.create');
    };

    const initializeSession = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          type: 'realtime',
          model: 'gpt-realtime',

          // Keep text enabled until debugging is done.
          // Once stable, you can change back to ['audio'].
          output_modalities: ['audio', 'text'],

          // KEY: turn on transcription so the model has semantic input
          input_audio_transcription: { model: 'whisper-1' },

          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              turn_detection: { type: 'server_vad' }
            },
            output: {
              format: { type: 'audio/pcmu' },
              voice: VOICE
            }
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

      safeSendOpenAI(sessionUpdate);
    };

    const sendMark = () => {
      if (!streamSid) return;
      connection.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } }));
      markQueue.push('responsePart');
    };

    const handleSpeechStartedEvent = () => {
      // Barge-in: stop assistant audio playback and cancel any in-flight response.
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;

        if (lastAssistantItem) {
          safeSendOpenAI({
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime
          });
        }

        if (responseInFlight) {
          safeSendOpenAI({ type: 'response.cancel' });
          responseInFlight = false;
          activeResponseId = null;
          queuedResponseCreate = false;
        }

        connection.send(JSON.stringify({ event: 'clear', streamSid }));

        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    openAiWs.on('open', () => {
      fastify.log.info('Connected to the OpenAI Realtime API');
      setTimeout(initializeSession, 100);
    });

    openAiWs.on('message', async (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          fastify.log.info({ type: response.type, response_id: response.response_id }, 'OpenAI event');
        }

        // Helpful: print transcription events so you can verify what caller said
        if (response.type === 'conversation.item.input_audio_transcription.completed') {
          fastify.log.info({ transcription_event: response }, 'TRANSCRIPTION COMPLETED (raw)');
        }

        // Track whether a response is in progress
        if (response.type === 'response.created') {
          responseInFlight = true;
          activeResponseId = response.response?.id ?? response.response_id ?? null;
        } else if (response.type === 'response.done') {
          responseInFlight = false;
          activeResponseId = null;

          if (queuedResponseCreate) {
            queuedResponseCreate = false;
            requestResponseCreate('queued_after_response_done');
          }
        } else if (response.response_id && response.type?.startsWith?.('response.')) {
          responseInFlight = true;
          activeResponseId = response.response_id;
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

        // ---- Tool calls: ONLY handle them from response.output_item.done ----
        if (response.type === 'response.output_item.done' && response.item?.type === 'function_call') {
          const functionCall = response.item;

          if (functionCall.name === 'kb_search' && functionCall.call_id) {
            const callId = functionCall.call_id;

            if (handledToolCalls.has(callId)) return;
            handledToolCalls.add(callId);

            const rawArgs = functionCall.arguments ?? functionCall.arguments_json ?? '{}';
            let args;
            try {
              args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
            } catch {
              args = {};
            }

            const query = (args?.query || '').toString().trim();
            fastify.log.info({ query, callId }, 'kb_search tool call');

            let kbJson;
            try {
              kbJson = await searchKb(query);
              fastify.log.info({ kbJson }, 'KB raw response');
            } catch (e) {
              kbJson = { error: String(e) };
              fastify.log.error({ err: String(e) }, 'KB search error');
            }

            const results = kbJson?.data || kbJson?.results || kbJson?.matches || [];

            // More robust extraction (different shapes exist depending on the API response)
            const passages = Array.isArray(results)
              ? results
                  .slice(0, 5)
                  .map((r) =>
                    r?.content?.[0]?.text?.value ??
                    r?.content?.[0]?.text ??
                    r?.text ??
                    r?.document?.text ??
                    (typeof r?.document === 'string' ? r.document : '')
                  )
                  .filter(Boolean)
                  .join('\n---\n')
              : '';

            safeSendOpenAI({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify({ query, passages })
              }
            });

            // Queue response.create if one is already active
            requestResponseCreate('after_kb_search_output');
          }
        }
      } catch (err) {
        fastify.log.error({ err: String(err) }, 'Error processing OpenAI message');
      }
    });

    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'start':
            streamSid = data.start.streamSid;
            fastify.log.info({ streamSid }, 'Incoming stream started');

            latestMediaTimestamp = 0;
            responseStartTimestampTwilio = null;
            lastAssistantItem = null;
            markQueue = [];

            responseInFlight = false;
            queuedResponseCreate = false;
            activeResponseId = null;
            handledToolCalls.clear();
            break;

          case 'media':
            latestMediaTimestamp = data.media.timestamp;
            if (openAiWs.readyState === WebSocket.OPEN) {
              safeSendOpenAI({ type: 'input_audio_buffer.append', audio: data.media.payload });
            }
            break;

          case 'connected':
            fastify.log.info('Received non-media event: connected');
            break;

          case 'stop':
            fastify.log.info('Received stop event from Twilio.');
            break;

          case 'mark':
            if (markQueue.length > 0) markQueue.shift();
            break;

          default:
            fastify.log.info({ event: data.event }, 'Received non-media event');
        }
      } catch (err) {
        fastify.log.error({ err: String(err) }, 'Error parsing Twilio message');
      }
    });

    // IMPORTANT: avoid "WebSocket was closed before the connection was established"
    connection.on('close', () => {
      fastify.log.info('Client disconnected (Twilio WS).');
      try {
        if (openAiWs.readyState === WebSocket.OPEN) {
          openAiWs.close(1000, 'twilio_disconnected');
        } else if (openAiWs.readyState === WebSocket.CONNECTING) {
          openAiWs.terminate();
        }
      } catch (e) {
        fastify.log.error({ err: String(e) }, 'Error closing OpenAI WS');
      }
    });

    openAiWs.on('close', () => fastify.log.info('Disconnected from OpenAI Realtime API'));
    openAiWs.on('error', (e) => fastify.log.error({ err: String(e) }, 'OpenAI WS error'));
  });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Server is listening on port ${PORT}`);
});
