const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });
app.use(cors());
app.use(bodyParser.json());

const AGENTS_FILE = path.join(__dirname, 'agents.json');
let agents = {};
if (fs.existsSync(AGENTS_FILE)) {
    agents = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
} else {
    agents = {};
    fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
}

const clients = {};

function saveAgents() {
    fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
}

app.get('/agents', (req, res) => {
    const agentList = Object.keys(agents).map(sessionId => ({
        sessionId,
        number: agents[sessionId].number || 'Desconocido',
        prompt: agents[sessionId].prompt || '',
        active: agents[sessionId].active !== false,
        connected: !!clients[sessionId]?.client?.info?.wid
    }));
    res.json(agentList);
});

app.post('/agents/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { prompt, active } = req.body;
    if (!agents[sessionId]) agents[sessionId] = {};
    if (prompt !== undefined) agents[sessionId].prompt = prompt;
    if (active !== undefined) agents[sessionId].active = active;
    saveAgents();
    res.json({ success: true });
});

app.post('/add-session', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId requerido' });
    if (clients[sessionId]) return res.status(400).json({ error: 'La sesión ya existe' });
    
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionId, dataPath: path.join(__dirname, 'sessions') }),
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });
    
    clients[sessionId] = { client, ready: false };
    
    client.on('qr', (qr) => {
        console.log(`QR para sesión ${sessionId}`);
        qrcode.generate(qr, { small: true });
        io.emit('qr', { sessionId, qr });
    });
    
    client.on('ready', async () => {
        console.log(`✅ Sesión ${sessionId} conectada`);
        clients[sessionId].ready = true;
        const info = client.info;
        const number = info.wid.user;
        if (!agents[sessionId]) agents[sessionId] = {};
        agents[sessionId].number = number;
        agents[sessionId].active = agents[sessionId].active !== false;
        if (!agents[sessionId].prompt) {
            agents[sessionId].prompt = "Eres un asistente de WhatsApp amigable y útil. Responde de forma natural y concisa.";
        }
        saveAgents();
        io.emit('session_ready', { sessionId, number });
    });
    
    client.on('message', async (message) => {
        if (!agents[sessionId]?.active) return;
        if (message.fromMe) return;
        
        const chat = await message.getChat();
        const contacto = await message.getContact();
        const userMessage = message.body;
        console.log(`[${sessionId}] Mensaje de ${contacto.pushname || contacto.number}: ${userMessage}`);
        
        io.emit('new_message', {
            sessionId,
            from: contacto.pushname || contacto.number,
            body: userMessage,
            timestamp: Date.now()
        });
        
        const systemPrompt = agents[sessionId].prompt || "Eres un asistente útil.";
        
        try {
            const gptResponse = await axios.post('https://orange-baboon-616741.hostingersite.com/gpt-proxy.php', {
                message: userMessage,
                systemPrompt: systemPrompt
            });
            const replyText = gptResponse.data.reply;
            if (replyText) {
                await message.reply(replyText);
                console.log(`[${sessionId}] 🤖 Respondido: ${replyText}`);
                io.emit('bot_reply', { sessionId, to: contacto.number, reply: replyText });
            }
        } catch (error) {
            console.error(`Error GPT en sesión ${sessionId}:`, error.message);
            await message.reply('⚠️ Error técnico, intenta más tarde.');
        }
    });
    
    client.initialize();
    res.json({ success: true, sessionId });
});

app.post('/send-message', async (req, res) => {
    const { sessionId, number, message } = req.body;
    if (!sessionId || !number || !message) return res.status(400).json({ error: 'Faltan datos' });
    const clientObj = clients[sessionId]?.client;
    if (!clientObj) return res.status(404).json({ error: 'Sesión no encontrada' });
    try {
        const chatId = number.includes('@c.us') ? number : `${number}@c.us`;
        await clientObj.sendMessage(chatId, message);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/close-session', async (req, res) => {
    const { sessionId } = req.body;
    if (clients[sessionId]) {
        await clients[sessionId].client.destroy();
        delete clients[sessionId];
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Sesión no existe' });
    }
});

app.get('/', (req, res) => {
    res.send('WhatsApp Multi-Agent Bot está corriendo. Usa /index.php para el panel.');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor multi-agente corriendo en puerto ${PORT}`);
});