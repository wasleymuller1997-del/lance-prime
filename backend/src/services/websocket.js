const Pusher = require('pusher-js');
const WebSocket = require('ws');

let wss = null;
let pusherClient = null;

function setupWebSocket(server) {
  wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    console.log('Cliente conectado ao WebSocket');
    ws.send(JSON.stringify({ type: 'connected', message: 'Conectado ao LancePrime' }));

    ws.on('close', () => {
      console.log('Cliente desconectado');
    });
  });

  console.log('WebSocket server pronto em /ws');
}

function broadcast(data) {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function connectToPusher(token) {
  if (pusherClient) {
    pusherClient.disconnect();
  }

  pusherClient = new Pusher('app-key', {
    wsHost: 'prod-reverb.dealersclub.com.br',
    wsPort: 443,
    wssPort: 443,
    forceTLS: true,
    enabledTransports: ['ws'],
    disableStats: true,
    authEndpoint: 'https://prod-backend.dealersclub.com.br/api/broadcasting/auth',
    auth: {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Origin': process.env.DEALERS_AUDITORIO_ORIGIN
      }
    }
  });

  const channel = pusherClient.subscribe('private-auditorium');

  channel.bind('pusher:subscription_succeeded', () => {
    console.log('Conectado ao canal private-auditorium');
  });

  channel.bind('pusher:subscription_error', (err) => {
    console.error('Erro ao conectar no Pusher:', err);
  });

  channel.bind_global((eventName, data) => {
    if (eventName.startsWith('_Advertisement.Updated.')) {
      const adId = eventName.replace('_Advertisement.Updated.', '');
      console.log(`Lance atualizado no anúncio ${adId}`);
      broadcast({
        type: 'bid_update',
        advertisement_id: parseInt(adId),
        data: data
      });
    }
  });

  console.log('Conectando ao Pusher da Dealers Club...');
}

module.exports = { setupWebSocket, connectToPusher, broadcast };
