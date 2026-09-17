// server.js
// Backend for the Alveer ("إلفير") Telegram WebApp voice-call UI.
//
// - Serves the static call UI from /public (index.html + assets).
// - Receives audio segments recorded by the browser at POST /api/audio.
// - Forwards each segment (audio + chat_id) to the configured n8n Production
//   Webhook (process.env.N8N_WEBHOOK_URL) using multipart/form-data via axios.
// - If no n8n webhook is configured (or the forward fails) and a Gemini API
//   key is available (process.env.GEMINI_API_KEY), falls back to processing
//   the audio directly against the Gemini API so the assistant still replies.
// - Always answers the client with 200 OK so the WebApp never sees a 404,
//   even if the downstream integration is temporarily unreachable.

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const FormData = require('form-data');

const app = express();

const PORT = process.env.PORT || 10000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the call UI and any other static assets from /public.
app.use(express.static(path.join(__dirname, 'public')));

// Accept audio segments in memory (no disk writes) — webm/ogg/wav/m4a.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024 // 25 MB per segment, generous for short voice clips
  },
  fileFilter: function (req, file, cb) {
    var allowed = [
      'audio/webm',
      'audio/ogg',
      'audio/wav',
      'audio/x-wav',
      'audio/mp4',
      'audio/m4a',
      'audio/mpeg'
    ];
    if (allowed.indexOf(file.mimetype) !== -1 || /^audio\//.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported audio mime type: ' + file.mimetype));
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Forward the received audio buffer + chat_id to the n8n Production Webhook.
 * Returns whatever JSON body n8n responds with (if any), or null on failure.
 */
async function forwardToN8n(fileBuffer, filename, mimetype, chatId) {
  if (!N8N_WEBHOOK_URL) return null;

  const form = new FormData();
  form.append('audio', fileBuffer, {
    filename: filename || 'segment.webm',
    contentType: mimetype || 'audio/webm'
  });
  form.append('chat_id', chatId || 'unknown');

  const response = await axios.post(N8N_WEBHOOK_URL, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 20000 // 20s — n8n workflow may call an LLM itself
  });

  return response.data || null;
}

/**
 * Fallback path: send the audio straight to the Gemini API for a direct
 * response, used when no n8n webhook is configured or the forward failed.
 * Returns a plain string reply, or null on failure.
 */
async function processWithGemini(fileBuffer, mimetype, chatId) {
  if (!GEMINI_API_KEY) return null;

  const base64Audio = fileBuffer.toString('base64');
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    GEMINI_MODEL +
    ':generateContent?key=' +
    GEMINI_API_KEY;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              'أنت المساعد الصوتي "إلفير". استمع للمقطع الصوتي التالي من المستخدم ' +
              '(معرّف المحادثة: ' + (chatId || 'unknown') + ') وردّ بإيجاز ووضوح باللغة العربية.'
          },
          {
            inline_data: {
              mime_type: mimetype || 'audio/webm',
              data: base64Audio
            }
          }
        ]
      }
    ]
  };

  const response = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 25000
  });

  const candidates = response.data && response.data.candidates;
  if (candidates && candidates[0] && candidates[0].content && candidates[0].content.parts) {
    const parts = candidates[0].content.parts;
    const textPart = parts.find(function (p) { return typeof p.text === 'string'; });
    if (textPart) return textPart.text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', function (req, res) {
  res.status(200).json({
    status: 'ok',
    n8n_configured: Boolean(N8N_WEBHOOK_URL),
    gemini_configured: Boolean(GEMINI_API_KEY)
  });
});

app.post('/api/audio', upload.single('audio'), async function (req, res) {
  try {
    if (!req.file) {
      // Still respond 200 so the WebApp's fetch() never surfaces a hard error
      // for what is usually just an empty/near-silent VAD segment.
      return res.status(200).json({ status: 'ignored', reason: 'no_audio_file' });
    }

    const chatId = req.body && req.body.chat_id ? String(req.body.chat_id) : 'unknown';
    const fileBuffer = req.file.buffer;
    const filename = req.file.originalname || 'segment.webm';
    const mimetype = req.file.mimetype || 'audio/webm';

    console.log(
      '[audio] received segment — chat_id=%s size=%dB type=%s',
      chatId,
      fileBuffer.length,
      mimetype
    );

    let replyText = null;
    let source = 'none';

    // 1) Primary path: forward to n8n so the full workflow (STT, routing,
    //    logging, Telegram reply, etc.) handles the segment.
    if (N8N_WEBHOOK_URL) {
      try {
        const n8nData = await forwardToN8n(fileBuffer, filename, mimetype, chatId);
        source = 'n8n';
        if (n8nData) {
          if (typeof n8nData === 'string') {
            replyText = n8nData;
          } else if (typeof n8nData.reply_text === 'string') {
            replyText = n8nData.reply_text;
          } else if (typeof n8nData.reply === 'string') {
            replyText = n8nData.reply;
          }
        }
      } catch (n8nErr) {
        console.error('[audio] n8n forward failed:', n8nErr.message);
      }
    }

    // 2) Fallback path: if n8n isn't configured, or it failed and produced
    //    no reply, try answering directly through the Gemini API.
    if (!replyText && GEMINI_API_KEY) {
      try {
        replyText = await processWithGemini(fileBuffer, mimetype, chatId);
        source = replyText ? 'gemini' : source;
      } catch (geminiErr) {
        console.error('[audio] Gemini processing failed:', geminiErr.message);
      }
    }

    // Always return 200 to the WebApp — the mic/VAD loop on the client
    // should never break because a downstream integration hiccuped.
    return res.status(200).json({
      status: 'ok',
      source: source,
      chat_id: chatId,
      reply_text: replyText
    });
  } catch (err) {
    console.error('[audio] unexpected error:', err);
    // Even on an unexpected failure, respond 200 with an error flag rather
    // than letting the client see a 404/500 and stall its call UI.
    return res.status(200).json({ status: 'error', message: err.message });
  }
});

// Multer / body errors (oversized file, bad mime type, etc.) still get a
// clean JSON response instead of an unhandled exception.
app.use(function (err, req, res, next) {
  if (err) {
    console.error('[error]', err.message);
    return res.status(200).json({ status: 'error', message: err.message });
  }
  next();
});

// Fallback: any non-API route serves index.html (useful if the WebApp uses
// client-side routes later on).
app.get('*', function (req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, function () {
  console.log('Alveer voice-call server listening on port ' + PORT);
  console.log('n8n webhook configured: ' + Boolean(N8N_WEBHOOK_URL));
  console.log('Gemini API configured: ' + Boolean(GEMINI_API_KEY));
});
