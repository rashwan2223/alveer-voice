// server.js
// Backend for the Alveer ("إلفير") Telegram WebApp voice-call UI.

// ---------------------------------------------------------------------------
// Defensive loading for dotenv & ws modules to prevent app crash on boot
// ---------------------------------------------------------------------------
try {
  require('dotenv').config();
} catch (e) {
  console.warn('[dotenv] module not available, continuing with process.env as-is:', e.message);
}

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const http = require('http');
const FormData = require('form-data');

let WebSocketServer = null;
try {
  WebSocketServer = require('ws').WebSocketServer;
} catch (e) {
  console.warn('[ws] module not available, running without WebSocket support:', e.message);
}

const app = express();
const server = http.createServer(app);

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

// Accept audio segments in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024 // 25 MB per segment
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
    timeout: 20000
  });

  return response.data || null;
}

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
    gemini_configured: Boolean(GEMINI_API_KEY),
    websocket: WebSocketServer ? 'ready' : 'disabled'
  });
});

app.post('/api/audio', upload.single('audio'), async function (req, res) {
  try {
    if (!req.file) {
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

    if (!replyText && GEMINI_API_KEY) {
      try {
        replyText = await processWithGemini(fileBuffer, mimetype, chatId);
        source = replyText ? 'gemini' : source;
      } catch (geminiErr) {
        console.error('[audio] Gemini processing failed:', geminiErr.message);
      }
    }

    broadcastToChat(chatId, {
      type: 'audio_reply',
      chat_id: chatId,
      source: source,
      reply_text: replyText
    });

    return res.status(200).json({
      status: 'ok',
      source: source,
      chat_id: chatId,
      reply_text: replyText
    });
  } catch (err) {
    console.error('[audio] unexpected error:', err);
    return res.status(200).json({ status: 'error', message: err.message });
  }
});

app.use(function (err, req, res, next) {
  if (err) {
    console.error('[error]', err.message);
    return res.status(200).json({ status: 'error', message: err.message });
  }
  next();
});

app.get('*', function (req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// WebSocket Server handling (Safe-mode)
// ---------------------------------------------------------------------------

const wsClientsByChat = new Map();

function broadcastToChat(chatId, payload) {
  const clients = wsClientsByChat.get(String(chatId));
  if (!clients || clients.size === 0) return;
  const message = JSON.stringify(payload);
  clients.forEach(function (client) {
    if (client.readyState === 1) { // 1 = OPEN
      try { client.send(message); } catch (e) {}
    }
  });
}

if (WebSocketServer) {
  const wss = new WebSocketServer({ server: server, path: '/ws' });
  wss.on('connection', function (ws, req) {
    let chatId = 'unknown';
    try {
      const url = new URL(req.url, 'http://localhost');
      chatId = url.searchParams.get('chat_id') || 'unknown';
    } catch (e) {}

    if (!wsClientsByChat.has(chatId)) wsClientsByChat.set(chatId, new Set());
    wsClientsByChat.get(chatId).add(ws);

    ws.on('close', function () {
      const set = wsClientsByChat.get(chatId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) wsClientsByChat.delete(chatId);
      }
    });

    ws.on('error', function (e) {
      console.error('[ws] client error:', e.message);
    });
  });
}

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------

server.listen(PORT, function () {
  console.log('Alveer voice-call server listening on port ' + PORT);
  console.log('n8n webhook configured: ' + Boolean(N8N_WEBHOOK_URL));
  console.log('Gemini API configured: ' + Boolean(GEMINI_API_KEY));
  console.log('WebSocket endpoint: ' + (WebSocketServer ? 'ready at /ws' : 'disabled'));
});
