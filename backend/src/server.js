const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// Validação crítica de variáveis de ambiente
if (!process.env.JWT_SECRET) {
  console.error('ERRO CRÍTICO: JWT_SECRET não configurado! O servidor não deve rodar em produção sem isso.');
}
if (!process.env.ADMIN_PASS) {
  console.error('AVISO: ADMIN_PASS não configurado. Login admin não funcionará.');
}

const vehiclesRoutes = require('./routes/vehicles');
const authRoutes = require('./routes/auth');
const pixRoutes = require('./routes/pix');
const { setupWebSocket, connectToPusher, setTokenProvider, getPusherState } = require('./services/websocket');
const dealers = require('./services/dealers');
const { initDB } = require('./services/db');
const { warmupOcr } = require('./services/dealerSanitize');

const app = express();
const PORT = process.env.PORT || 3001;

// === SEGURANÇA ===
// Helmet: headers de segurança
app.use(helmet({
  contentSecurityPolicy: false, // Desabilitado para permitir inline scripts do frontend
  crossOriginEmbedderPolicy: false
}));

// Rate limiting geral
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 1000, // máximo 1000 requests por IP
  message: { success: false, error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});

// Rate limiting mais restrito para autenticação
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20, // máximo 20 tentativas de login
  message: { success: false, error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' }
});

// Rate limiting para lances (evita spam)
const bidLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 30, // máximo 30 lances por minuto
  message: { success: false, error: 'Muitos lances em pouco tempo. Aguarde um momento.' }
});

app.use(generalLimiter);
app.use(cors());
app.use(express.json({ limit: '1mb' })); // Limitar tamanho do body

// Aplicar rate limit específico para rotas sensíveis
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/admin-login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/vehicles/:id/bid', bidLimiter);
app.use('/api/vehicles/:id/auto-bid', bidLimiter);

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

app.use(express.static(path.join(__dirname, '../../frontend'), {
  setHeaders: (res, filePath) => {
    // HTML sempre revalida (assim mudanças aparecem logo apos o deploy, sem o
    // navegador segurar a versao antiga em cache). Assets seguem o cache padrao.
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

const server = http.createServer(app);
setupWebSocket(server);

server.listen(PORT, async () => {
  console.log(`LancePrime rodando em http://localhost:${PORT}`);
  // NÃO pré-carregar OCR no boot: Tesseract + mupdf comem muita RAM e estouram
  // os 512MB do Render free (instância caía com OOM, derrubando todo o backend
  // — inclusive a FIPE). O carregamento é lazy: acontece no 1º laudo aberto
  // (custa ~10s só nessa primeira vez). Habilite o warmup só se tiver RAM:
  if (process.env.OCR_WARMUP === '1') warmupOcr();
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
