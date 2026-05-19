const WebSocket = require('ws');

let wss = null;
let pusherClient = null;
let reconnectTimer = null;
let getDealersToken = null;

// Spread de 5% nos preços em tempo real
const SPREAD = 0.05;
function applySpread(value) {
  if (!value || isNaN(value)) return value;
  return Math.round(value * (1 + SPREAD));
}

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

async function reconnectPusher() {
  if (!getDealersToken) return;
  try {
    const token = await getDealersToken();
    if (token) {
      console.log('Reconectando Pusher com token renovado...');
      connectToPusher(token);
    }
  } catch (err) {
    console.error('Erro ao reconectar Pusher:', err.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(reconnectPusher, 30000);
}

function connectToPusher(token) {
  try {
    if (pusherClient) {
      pusherClient.disconnect();
    }

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const pusherModule = require('pusher-js');
    const Pusher = typeof pusherModule === 'function' ? pusherModule : (pusherModule.Pusher || pusherModule.default);

    pusherClient = new Pusher('app-key', {
      cluster: 'mt1',
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

  pusherClient.connection.bind('connected', () => {
    console.log('Pusher conectado com sucesso');
  });

  pusherClient.connection.bind('disconnected', () => {
    console.log('Pusher desconectado — agendando reconexão');
    scheduleReconnect();
  });

  pusherClient.connection.bind('error', (err) => {
    console.error('Pusher erro:', err);
    scheduleReconnect();
  });

  const channel = pusherClient.subscribe('private-auditorium');

  channel.bind('pusher:subscription_succeeded', () => {
    console.log('Conectado ao canal private-auditorium');
  });

  channel.bind('pusher:subscription_error', (err) => {
    console.error('Erro ao conectar no Pusher:', err);
    scheduleReconnect();
  });

  channel.bind_global((eventName, data) => {
    if (eventName.startsWith('_Advertisement.Updated.')) {
      const adId = eventName.replace('_Advertisement.Updated.', '');
      console.log(`Lance atualizado no anúncio ${adId}`, JSON.stringify(data).substring(0, 300));

      // Aplicar spread nos valores em tempo real
      const spreadData = { ...data };
      if (spreadData.value_actual) spreadData.value_actual = applySpread(spreadData.value_actual);
      if (spreadData.offer_actual && spreadData.offer_actual.price) {
        spreadData.offer_actual = { ...spreadData.offer_actual, price: applySpread(spreadData.offer_actual.price) };
      }

      broadcast({
        type: 'bid_update',
        advertisement_id: parseInt(adId),
        data: spreadData
      });
    }
  });

  console.log('Conectando ao Pusher da Dealers Club...');
  } catch (err) {
    console.error('Erro fatal ao criar Pusher:', err);
    scheduleReconnect();
  }
}

function getPusherState() {
  if (!pusherClient) return { connected: false, reason: 'no client' };
  return {
    connected: pusherClient.connection.state === 'connected',
    state: pusherClient.connection.state,
    socketId: pusherClient.connection.socket_id || null
  };
}

module.exports = { setupWebSocket, connectToPusher, broadcast, setTokenProvider, getPusherState };
