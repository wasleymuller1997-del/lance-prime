const axios = require('axios');

const BASE_URL = process.env.NUVENDE_BASE_URL || 'https://api-h.nuvende.com.br';
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const clientId = process.env.NUVENDE_CLIENT_ID || process.env.NUVENDE_SANDBOX_CLIENT_ID;
  const clientSecret = process.env.NUVENDE_CLIENT_SECRET || process.env.NUVENDE_SANDBOX_CLIENT_SECRET;

  if (!clientId || !clientSecret) throw new Error('Credenciais Nuvende não configuradas');

  const res = await axios.post(`${BASE_URL}/api/v2/auth/login`, 
    `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}&scope=cob.read cob.write pix.read`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );

  tokenCache = { token: res.data.access_token, expiresAt: Date.now() + (res.data.expires_in - 60) * 1000 };
  return tokenCache.token;
}

function generateTxid() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let txid = 'lp';
  for (let i = 0; i < 30; i++) txid += chars[Math.floor(Math.random() * chars.length)];
  return txid;
}

async function criarCobrancaPix({ valor, descricao, devedor, expiracaoSegundos }) {
  const token = await getAccessToken();
  const pixKey = process.env.NUVENDE_PIX_KEY || process.env.NUVENDE_SANDBOX_PIX_KEY;
  if (!pixKey) throw new Error('Chave PIX não configurada');

  const txid = generateTxid();
  const expiracao = Math.max((expiracaoSegundos || 3600) - 60, 300);

  const body = {
    chave: pixKey,
    nomeRecebedor: 'Lance Prime Cars',
    solicitacaoPagador: descricao || 'Pagamento Lance Prime',
    calendario: { expiracao },
    valor: { original: parseFloat(valor).toFixed(2), modalidadeAlteracao: 0 }
  };

  if (devedor && devedor.cpf) {
    body.devedor = { nome: devedor.nome, cpf: devedor.cpf.replace(/\D/g, '') };
  }

  const res = await axios.put(`${BASE_URL}/api/v2/cobranca/cob/${txid}`, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });

  return {
    txid: res.data.txid || txid,
    pixCopiaCola: res.data.pixCopiaECola || res.data.pix_copia_cola || '',
    location: res.data.location || '',
    status: res.data.status || 'ATIVA',
    valor: valor
  };
}

async function consultarCobranca(txid) {
  const token = await getAccessToken();
  try {
    const res = await axios.get(`${BASE_URL}/api/v2/cobranca/cob/${txid}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000
    });
    return res.data;
  } catch (err) {
    if (err.response && (err.response.status === 404 || err.response.status === 400)) {
      return { txid, status: 'NOT_FOUND' };
    }
    throw err;
  }
}

module.exports = { criarCobrancaPix, consultarCobranca, generateTxid };
