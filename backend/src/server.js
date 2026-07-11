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
// Isolado: se o modulo de marketing quebrar por qualquer motivo (SDK,
// env, etc.), o servidor sobe normal e o resto do site funciona.
let marketingRoutes = null;
try {
  marketingRoutes = require('./routes/marketing');
} catch (e) {
  console.warn('[server] routes/marketing nao carregou:', e.message, '— aba Marketing ficara indisponivel.');
}
// Isolado igual ao marketing: app de figurinhas (radar + reputação). Cria as
// próprias tabelas no 1º request; se quebrar, o resto do site segue de pé.
let figurinhasRoutes = null;
try {
  figurinhasRoutes = require('./routes/figurinhas');
} catch (e) {
  console.warn('[server] routes/figurinhas nao carregou:', e.message, '— radar de figurinhas ficara indisponivel.');
}
// Isolado: tradutor de viagem (/tradutor). Se quebrar, o site segue de pé.
let traducaoRoutes = null;
try {
  traducaoRoutes = require('./routes/traducao');
} catch (e) {
  console.warn('[server] routes/traducao nao carregou:', e.message, '— tradutor /tradutor ficara indisponivel.');
}
// Isolado: relay do robô de cripto (painel /robocrypto). Se quebrar, o site segue de pé.
let robocryptoRoutes = null;
try {
  robocryptoRoutes = require('./routes/robocrypto');
} catch (e) {
  console.warn('[server] routes/robocrypto nao carregou:', e.message, '— painel /robocrypto ficara indisponivel.');
}
const { setupWebSocket, connectToPusher, setTokenProvider, getPusherState, setInvalidateCache } = require('./services/websocket');
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
app.use(express.json({ limit: '10mb' })); // Body limit (uploads de documentos + comprovantes de custos em base64)

// Aplicar rate limit específico para rotas sensíveis
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/admin-login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/vehicles/:id/bid', bidLimiter);
app.use('/api/vehicles/:id/auto-bid', bidLimiter);

// Bloqueio por IP banido (best-effort) — SO nas rotas sensiveis (login/
// cadastro/lance). Nunca nos estaticos, pra um IP banido nao derrubar o site
// inteiro pra ele. NAO aplica no admin-login (o dono precisa sempre entrar).
if (authRoutes.blockBannedIp) {
  app.use('/api/auth/login', authRoutes.blockBannedIp);
  app.use('/api/auth/register', authRoutes.blockBannedIp);
  app.use('/api/vehicles/:id/bid', authRoutes.blockBannedIp);
  app.use('/api/vehicles/:id/auto-bid', authRoutes.blockBannedIp);
}

app.use('/api', vehiclesRoutes);
// Liga a invalidação do cache de veículos no bridge do WebSocket — cada
// lance ao vivo zera o cache pra o poll-relâmpago do cliente pegar o
// finish_date_offer novo (Pusher da origem nem sempre carrega o tempo).
if (vehiclesRoutes.invalidateVehiclesCache) setInvalidateCache(vehiclesRoutes.invalidateVehiclesCache);
app.use('/api/auth', authRoutes);
app.use('/api', pixRoutes);
if (marketingRoutes) app.use('/api', marketingRoutes);
if (figurinhasRoutes) app.use('/api', figurinhasRoutes);
if (robocryptoRoutes) app.use('/api', robocryptoRoutes);
if (traducaoRoutes) app.use('/api', traducaoRoutes);

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
    // Service worker e manifest: sempre revalidar (assim atualizacoes do PWA
    // chegam na hora). Service worker ainda precisa do content-type certo.
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/');
    }
    if (filePath.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// URLs amigáveis pra Vitrine: /loja, /vitrine, /showroom → servem index.html
// e o frontend redireciona internamente pra #showroom. Link fica mais bonito
// pra divulgar (sem o #) e funciona quando alguém compartilha.
app.get(['/loja', '/vitrine', '/showroom'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});

// URL amigável pro app de figurinhas: /figurinhas → serve a página do app.
app.get('/figurinhas', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, '../../frontend/figurinhas.html'));
});

// Robô de cripto EMBUTIDO: roda o binance-bot (conta demo) dentro deste
// processo, então o painel /robocrypto funciona sem nenhum outro computador.
// Desative com ROBO_EMBEDDED=off. Se falhar por qualquer motivo, só loga —
// o site segue de pé.
if (robocryptoRoutes && robocryptoRoutes.injectReport && process.env.ROBO_EMBEDDED !== 'off') {
  const { pathToFileURL } = require('url');
  const embedPath = pathToFileURL(path.join(__dirname, '../../binance-bot/embed.js')).href;
  // Persistência do robô no Postgres do site: deploys/reinícios não zeram
  // saldos, posições nem histórico da competição.
  const { pool: roboPool } = require('./services/db');
  const roboStorage = {
    async init() {
      await roboPool.query(`
        CREATE TABLE IF NOT EXISTS robocrypto_kv (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
    },
    async load(key) {
      const r = await roboPool.query('SELECT value FROM robocrypto_kv WHERE key = $1', [key]);
      return r.rows[0] ? r.rows[0].value : null;
    },
    async save(key, value) {
      await roboPool.query(
        `INSERT INTO robocrypto_kv (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, JSON.stringify(value)]
      );
    },
  };
  import(embedPath)
    .then((m) => m.startEmbedded({ report: robocryptoRoutes.injectReport, storage: roboStorage }))
    .then(() => console.log('[server] robo de cripto embutido rodando (conta demo)'))
    .catch((e) => console.warn('[server] robo embutido nao iniciou:', e.message, '— painel /robocrypto fica aguardando um robo externo.'));
}

// URL amigável pro painel do robô de cripto: /robocrypto.
app.get('/robocrypto', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, '../../frontend/robocrypto.html'));
});
// Erros comuns de digitação também levam pro painel.
app.get(['/cryptorobo', '/robocripto', '/criptorobo'], (req, res) => res.redirect('/robocrypto'));

// URL amigável pro tradutor de viagem: /tradutor (PWA pra instalar no celular).
app.get('/tradutor', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, '../../frontend/tradutor.html'));
});
// Variações comuns também levam pro tradutor.
app.get(['/traducao', '/traductor', '/translate', '/chile'], (req, res) => res.redirect('/tradutor'));

// URL amigável pro painel admin: /admin → admin.html (antes só /admin.html abria).
app.get('/admin', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, '../../frontend/admin.html'));
});

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

  // Reconciliacao de lances vencedores: critico pra detectar quem ganhou em
  // SEGUNDOS, nao minutos — sem isso o cliente nao recebe email/aviso a tempo
  // do prazo de 5min do sinal.
  // Estrategia: cron periodico de 1min (cobre todos os lances) + tick de 15s
  // que olha SO lances vencendo nos proximos 30s (chega no fechamento e roda
  // imediatamente). 30s de grace pos-fechamento pra Dealers processar o ultimo
  // lance-relampago.
  if (process.env.RECONCILE_DISABLED !== '1') {
    const { reconcileOnce, captureClosingWinners } = require('./services/bidReconciliation');
    setTimeout(() => {
      reconcileOnce().then(s => console.log('[reconcile] boot:', JSON.stringify(s)))
        .catch(e => console.log('[reconcile] boot erro:', e.message));
    }, 30000);
    setInterval(() => {
      reconcileOnce().then(s => {
        if (s.bids_marked_won || s.bids_marked_lost) console.log('[reconcile]', JSON.stringify(s));
      }).catch(e => console.log('[reconcile] erro:', e.message));
    }, 60 * 1000);
    // VIGIA DE FECHAMENTO: a cada 20s captura quem esta ganhando nos leiloes
    // que estao fechando, ENQUANTO a Dealers ainda devolve as ofertas. Assim,
    // no fechamento o vencedor ja esta salvo e a reconciliacao dispara o 10%
    // na hora — sem depender da Dealers responder depois.
    setInterval(() => {
      captureClosingWinners().then(s => {
        if (s && s.bids_updated) console.log('[capture]', JSON.stringify(s));
      }).catch(e => console.log('[capture] erro:', e.message));
    }, 20 * 1000);
  }
});
