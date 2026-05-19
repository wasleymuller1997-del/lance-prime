const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const vehiclesRoutes = require('./routes/vehicles');
const authRoutes = require('./routes/auth');
const pixRoutes = require('./routes/pix');
const { setupWebSocket, connectToPusher, setTokenProvider, getPusherState } = require('./services/websocket');
const dealers = require('./services/dealers');
const { initDB } = require('./services/db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api', vehiclesRoutes);
app.use('/api/auth', authRoutes);
app.use('/api', pixRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/reconnect-pusher', async (req, res) => {
  try {
    const loginResult = await dealers.login();
    const token = dealers.token;
    if (!token) {
      return res.json({ success: false, error: 'Token vazio após login', loginResult });
    }
    connectToPusher(token);
    res.json({ success: true, message: 'Pusher reconectado', tokenLength: token.length, tokenExpires: dealers.tokenExpiresAt });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || String(err), stack: err.stack ? err.stack.split('\n').slice(0,3) : null });
  }
});

app.get('/api/pusher-status', (req, res) => {
  res.json(getPusherState());
});

app.use(express.static(path.join(__dirname, '../../frontend')));

const server = http.createServer(app);
setupWebSocket(server);

server.listen(PORT, async () => {
  console.log(`LancePrime rodando em http://localhost:${PORT}`);
  try {
    await initDB();
    console.log('Banco de dados inicializado');
  } catch (err) {
    console.log('DB init error:', err.message);
  }
  try {
    await dealers.login();
    setTokenProvider(async () => {
      await dealers.login();
      return dealers.token;
    });
    connectToPusher(dealers.token);
  } catch (err) {
    console.log('Pusher: conecta quando primeiro request for feito');
  }
});
