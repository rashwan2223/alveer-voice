const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// رابط الـ Webhook الصريح من n8n maltak
const N8N_WEBHOOK_URL = "https://rj-src.com/webhook/voice-agent";
const GEMINI_API_KEY = "AQ.Ab8RN6ISLMygv8MKu91VU5CHZdQWMmTQ4hPpQ8Uyc1cEh4ruCg";

app.use(express.json());
app.use(express.static('public')); // ينقل ملف index.html للواجهة

// إدارة اتصالات الصوت الحية
wss.on('connection', (ws) => {
    console.log('⚡ مكالمة جديدة انفتحت ويا إلفير');

    ws.on('message', async (message) => {
        // استقبال حزم الصوت من الموبايل وتمريرها لـ Gemini Live
    });

    ws.on('close', () => console.log('❌ انتهت المكالمة'));
});

// دالة استدعاء أتمتة n8n عند الحاجة للأدوات
async function triggerN8nTools(userQuery) {
    try {
        const response = await axios.post(N8N_WEBHOOK_URL, { chatInput: userQuery });
        return response.data.output || "تم تنفيذ الطلب يا حاج.";
    } catch (error) {
        console.error("خطأ بالربط ويا n8n:", error.message);
        return "صار عائق بسيط بالوصول للبيانات.";
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 سيرفر إلفير شغال على البورت ${PORT}`));