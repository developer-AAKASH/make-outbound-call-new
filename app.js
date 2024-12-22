import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';
import axios from 'axios';
// import speech from '@google-cloud/speech';
//
// const googleClient = new speech.SpeechClient();
// const speechToTextRequest = {
//     config: {
//         encoding: 'MULAW', // Twilio sends audio in MULAW format
//         sampleRateHertz: 8000, // Twilio streams at 8000 Hz
//         languageCode: 'en-US',
//     },
//     interimResults: true, // If you want interim results
// };
// // Create a recognition stream
// const recognizeStream = googleClient
//     .streamingRecognize(speechToTextRequest)
//     .on('data', async (data) => {
//         if (data.results[0] && data.results[0].alternatives[0]) {
//             const userInput = data.results[0].alternatives[0].transcript;
//             console.log('User said:', userInput);
//
//             // Detect intent and trigger events
//             // const intent = await classifyIntent(userInput);
//             // if (intent === 'appointment') {
//             //     console.log('Triggering appointment booking logic...');
//             // }
//
//             console.log("\n\n\nThats what User said:::::", userInput);
//         }
//     })
//     .on('error', (err) => console.error('Speech recognition error:', err))
//     .on('end', () => console.log('Speech recognition stream ended.'));

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key, Twilio Account Credentials, outgoing phone number, and public domain address from environment variables.
const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    PHONE_NUMBER_FROM,
    DOMAIN: rawDomain,
    OPENAI_API_KEY,
} = process.env;

// Constants
const DOMAIN = rawDomain.replace(/(^\w+:|^)\/\//, '').replace(/\/+$/, ''); // Clean protocols and slashes
const SYSTEM_MESSAGE = 'You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested in and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.';
const VOICE = 'alloy';
const PORT = process.env.PORT || 6060; // Allow dynamic port assignment
const outboundTwiML = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${DOMAIN}/media-stream" /></Connect></Response>`;

// List of Event Types to log to the console. See the OpenAI Realtime API Documentation.
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !PHONE_NUMBER_FROM || !rawDomain || !OPENAI_API_KEY) {
    console.error('One or more environment variables are missing. Please ensure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PHONE_NUMBER_FROM, DOMAIN, and OPENAI_API_KEY are set.');
    process.exit(1);
}

async function isNumberAllowed(to) {
    try {

        // Uncomment these lines to test numbers. Only add numbers you have permission to call
        // const consentMap = {"+18005551212": true}
        // if (consentMap[to]) return true;

        // Check if the number is a Twilio phone number in the account, for example, when making a call to the Twilio Dev Phone
        const incomingNumbers = await client.incomingPhoneNumbers.list({ phoneNumber: to });
        if (incomingNumbers.length > 0) {
            return true;
        }

        // Check if the number is a verified outgoing caller ID. https://www.twilio.com/docs/voice/api/outgoing-caller-ids
        const outgoingCallerIds = await client.outgoingCallerIds.list({ phoneNumber: to });
        if (outgoingCallerIds.length > 0) {
            return true;
        }

        return false;
    } catch (error) {
        console.error('Error checking phone number:', error);
        return false;
    }
}

async function makeCall(to) {
    try {
        const isAllowed = await isNumberAllowed(to);
        if (!isAllowed) {
            console.warn(`The number ${to} is not recognized as a valid outgoing number or caller ID.`);
            process.exit(1);
        }

        const call = await client.calls.create({
            from: PHONE_NUMBER_FROM,
            to,
            twiml: outboundTwiML,
        });
        console.log(`Call started with SID: ${call.sid}`);
    } catch (error) {
        console.error('Error making call:', error);
    }
}

const handleUserInterruption = async (twilioWebSocket, openAIWebSocket, streamSid) => {
    // Define a function to handle interruptions
    console.log('User started speaking, clearing current AI response.');

    // Step 1: Clear Twilio's audio buffer
    const clearTwilioBuffer = {
        streamSid: streamSid,
        event: 'clear', // Twilio event to stop ongoing playback
    };
    await twilioWebSocket.send(JSON.stringify(clearTwilioBuffer));
    console.log('Twilio audio buffer cleared.');

    // Step 2: Cancel the OpenAI response
    const cancelAIResponse = {
        type: 'response.cancel', // OpenAI event to cancel the response
    };
    await openAIWebSocket.send(JSON.stringify(cancelAIResponse));
    console.log('OpenAI response canceled.');
};

async function classifyIntent(userInput) {
    const response = await axios.post(
        'https://api.openai.com/v1/completions',
        {
            model: 'text-davinci-003',
            prompt: `Identify the intent of the following user input and respond with a single word (e.g., "appointment", "query", "complaint", "greeting"):\n\n"${userInput}"`,
            max_tokens: 10,
        },
        {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
        }
    );

    const intent = response.data.choices[0].text.trim();
    console.log('\n\n\nIdentified Intent:', intent);
    return intent;
}

// Initialize the Twilio library and set our outgoing call TwiML
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize Fastify
const app = Fastify();
app.register(fastifyFormBody);
app.register(fastifyWs);

// Root Route
app.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// WebSocket route for media-stream
app.register(async (app) => {
    // Setup WebSocket server for handling media streams
    app.get('/media-stream', {websocket: true}, (connection, req) => {
        console.log('Client connected');

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        let streamSid = null;

        const sendInitialSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));

            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: 'Greet the user with "Hello there! I\'m an AI voice assistant from Twilio and the OpenAI Realtime API. How can I help?"'
                        }
                    ]
                }
            };

            console.log("\n\nSending Initial.....\n\n");
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(sendInitialSessionUpdate, 100); // Ensure connection stability, send after .1 second
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', async (data) => {
            try {
                const response = JSON.parse(data);

                if (response.type === 'input_audio_buffer.speech_started') {
                    console.log("OPenAI::::::::Clearing Buffer of OpenAI.");
                    await handleUserInterruption(connection, openAiWs, streamSid);
                }

                console.log('OpenAI Events::::::::', response.type);

                if (response.type === 'conversation.item.created') {
                    console.log(":::Response Conversation::::", response);
                    console.log(":::Response Conversation::::", response.item.content);

                }

                // if (response.type === 'transcription') {
                //     const userInput = response.text;
                //     console.log('\n\n\n::::::User said:', userInput);
                //
                //     // Detect intent and trigger events
                //     // const intent = await classifyIntent(userInput);
                //     // if (intent === 'appointment') {
                //     //     console.log('Triggering appointment booking logic...');
                //     // }
                // }

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`);
                }

                if (response.type === 'session.updated') {
                    console.log('Session updated successfully:', response);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', async (message) => {
            try {
                const data = JSON.parse(message);

                // if (data.event === 'media') {
                //     const audioData = Buffer.from(data.media.payload, 'base64');
                //     recognizeStream.write(audioData);
                // }

                if (data.event === 'speech.transcription') {
                    const userInput = data.transcription.text;
                    console.log('\n\n\nUser said:', userInput);

                    // Detect intent and trigger events
                    const intent = await classifyIntent(userInput);
                    if (intent === 'appointment') {
                        console.log('\n\n\nTriggering appointment booking logic...\n\n\n');
                    }
                }

                if (data.event === 'input_audio_buffer.speech_started') {
                    console.log("Twilio::::::::");
                }

                switch (data.event) {
                    case 'media':
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };

                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

// Initialize server
app.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);

    // Parse command-line arguments to get the phone number
    const args = process.argv.slice(2);
    const phoneNumberArg = args.find(arg => arg.startsWith('--call='));
    if (!phoneNumberArg) {
        console.error('Please provide a phone number to call, e.g., --call=+18885551212');
        process.exit(1);
    }
    console.log(
        'Our recommendation is to always disclose the use of AI for outbound or inbound calls.\n'+
        'Reminder: all of the rules of TCPA apply even if a call is made by AI \n' +
        'Check with your counsel for legal and compliance advice.'
    );
    const phoneNumberToCall = phoneNumberArg.split('=')[1].trim();
    console.log('Calling ', phoneNumberToCall);
    makeCall(phoneNumberToCall);
});
