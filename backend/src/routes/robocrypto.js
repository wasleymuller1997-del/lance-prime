// Relay do Robô Crypto (binance-bot): o robô roda na máquina do usuário e
// NÃO é alcançável pela internet — então ele mesmo reporta o status pra cá
// a cada poucos segundos e, na resposta, leva os comandos que o painel
// /robocrypto enfileirou (encerrar posição, pausar, retomar).
//
// Autenticação:
//   - robô → servidor: header X-Robo-Key igual à env ROBO_KEY
//   - painel → servidor: mesmo JWT de admin do painel /admin (requireAdmin)
const express = require('express');
const crypto = require('crypto');
const { requireAdmin } = require('./auth');

const router = express.Router();

// Estado em memória basta: o robô reporta de novo a cada ~7s e o painel só
// mostra "ao vivo"; nada aqui precisa sobreviver a um redeploy.
let lastReport = null; // { state, receivedAt }
let commands = []; // [{ id, action, symbol, queuedAt }]
const ONLINE_MS = 30_000;

function requireBotKey(req, res, next) {
  const configured = process.env.ROBO_KEY || '';
  if (!configured) {
    return res.status(503).json({ success: false, error: 'ROBO_KEY não configurada no servidor' });
  }
  const got = String(req.headers['x-robo-key'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(configured);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, error: 'chave inválida' });
  }
  next();
}

// Robô → servidor: entrega o status e recebe os comandos pendentes.
router.post('/robocrypto/report', requireBotKey, (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ success: false, error: 'status ausente' });
  }
  lastReport = { state: req.body, receivedAt: Date.now() };
  const deliver = commands;
  commands = [];
  res.json({ success: true, commands: deliver });
});

// Painel → status mais recente + se o robô está online.
router.get('/robocrypto/state', requireAdmin, (req, res) => {
  if (!lastReport) {
    return res.json({ success: true, online: false, ageMs: null, state: null, pendingCommands: commands.length });
  }
  const ageMs = Date.now() - lastReport.receivedAt;
  res.json({ success: true, online: ageMs < ONLINE_MS, ageMs, state: lastReport.state, pendingCommands: commands.length });
});

// Painel → enfileira um comando pro robô executar no próximo report.
router.post('/robocrypto/command', requireAdmin, (req, res) => {
  const { action, symbol } = req.body || {};
  if (!['close', 'pause', 'resume'].includes(action)) {
    return res.status(400).json({ success: false, error: 'ação inválida (use close, pause ou resume)' });
  }
  if (action === 'close' && !symbol) {
    return res.status(400).json({ success: false, error: 'símbolo obrigatório para encerrar' });
  }
  const duplicado = commands.some((c) => c.action === action && c.symbol === (symbol || null));
  if (!duplicado) {
    commands.push({ id: crypto.randomUUID(), action, symbol: symbol || null, queuedAt: Date.now() });
  }
  res.json({ success: true, pendingCommands: commands.length });
});

module.exports = router;
