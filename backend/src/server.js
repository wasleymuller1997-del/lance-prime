const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const vehiclesRoutes = require('./routes/vehicles');
const authRoutes = require('./routes/auth');
const { setupWebSocket, connectToPusher } = require('./services/websocket');
const dealers = require('./services/dealers');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api', vehiclesRoutes);
app.use('/api/auth', authRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, '../../frontend')));

const server = http.createServer(app);
setupWebSocket(server);

server.listen(PORT, async () => {
  console.log(`LancePrime rodando em http://localhost:${PORT}`);
  try {
    await dealers.login();
    connectToPusher(dealers.token);
  } catch (err) {
    console.log('Pusher: conecta quando primeiro request for feito');
  }
});
