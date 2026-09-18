// server.js
// Backend for the Alveer ("إلفير") Telegram WebApp voice-call UI.

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

app.use(express.static(path.join(__dirname, 'public')));

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

  // استلام الرد كـ arraybuffer لدعم ملفات الصوت الثنائية (Binary MP3)
  const response = await axios.post(N8N_WEBHOOK_URL, form, {
    headers: form.getHeaders(),
    responseType: 'arraybuffer',
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 20000
  });

  return response.data || null;
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
      return res.status(400).send('No audio file provided');
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

    if (N8N_WEBHOOK_URL) {
      try {
        const audioBuffer = await forwardToN8n(fileBuffer, filename, mimetype, chatId);
        if (audioBuffer) {
          // إرسال ملف الصوت المباشر القادم من n8n للواجهة
          res.setHeader('Content-Type', 'audio/mpeg');
          return res.status(200).send(Buffer.from(audioBuffer));
        }
      } catch (n8nErr) {
        console.error('[audio] n8n forward failed:', n8nErr.message);
      }
    }

    return res.status(500).send('Audio generation failed');
  } catch (err) {
    console.error('[audio] unexpected error:', err);
    return res.status(500).send(err.message);
  }
});

app.use(function (err, req, res, next) {
  if (err) {
    console.error('[error]', err.message);
    return res.status(500).send(err.message);
  }
  next();
});

app.get('*', function (req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------

server.listen(PORT, function () {
  console.log('Alveer voice-call server listening on port ' + PORT);
  console.log('n8n webhook configured: ' + Boolean(N8N_WEBHOOK_URL));
});
