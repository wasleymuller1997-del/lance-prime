import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = path.join(ROOT, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
};

// Painel web (PWA) servido pelo próprio robô: status ao vivo, encerrar
// posição a mercado e pausar/retomar novas entradas.
// Proteja com DASHBOARD_TOKEN no .env se for expor fora da sua rede.
export function startDashboard({ bot, broker, client, config, logger }) {
  const port = Number(process.env.DASHBOARD_PORT || config.dashboardPort || 8484);
  const token = process.env.DASHBOARD_TOKEN || '';

  function send(res, code, body, headers = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ...headers });
    res.end(data);
  }

  function authorized(req, url) {
    if (!token) return true;
    return req.headers.authorization === `Bearer ${token}` || url.searchParams.get('token') === token;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 10_000) reject(new Error('corpo grande demais'));
      });
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          reject(new Error('JSON inválido'));
        }
      });
      req.on('error', reject);
    });
  }

  async function status() {
    const balance = await broker.balanceForRisk();
    const dayStart = broker.state?.dayStartBalance ?? broker.dayStartBalance ?? balance;
    const positions = [];
    for (const symbol of config.symbols) {
      const pos = broker.getPosition(symbol);
      if (!pos) continue;
      let mark = bot.lastPrices[symbol]?.price ?? pos.entryPrice;
      try {
        mark = await client.price(symbol);
      } catch {
        /* usa o último preço conhecido */
      }
      const gross = pos.side === 'long' ? (mark - pos.entryPrice) * pos.qty : (pos.entryPrice - mark) * pos.qty;
      const margin = (pos.entryPrice * pos.qty) / config.leverage;
      const openedMs = typeof pos.openedAt === 'string' ? Date.parse(pos.openedAt) : pos.openedAt;
      positions.push({
        symbol,
        side: pos.side,
        qty: pos.qty,
        entryPrice: pos.entryPrice,
        sl: pos.sl ?? null,
        tp: pos.tp ?? null,
        markPrice: mark,
        pnl: gross,
        pnlPct: margin > 0 ? (gross / margin) * 100 : 0,
        openedAt: openedMs,
        unprotected: Boolean(pos.unprotected),
      });
    }
    return {
      mode: config.mode,
      symbols: config.symbols,
      interval: config.interval,
      leverage: config.leverage,
      paused: bot.paused,
      balance,
      dayPnl: balance - dayStart,
      positions,
      updatedAt: Date.now(),
    };
  }

  function trades() {
    const file = path.join(DATA_DIR, config.mode === 'paper' ? 'trades.csv' : 'trades-testnet.csv');
    if (!fs.existsSync(file)) return { trades: [] };
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const cols = lines[0].split(',');
    const rows = lines.slice(1).slice(-30).map((line) => {
      const values = line.split(',');
      return Object.fromEntries(cols.map((c, i) => [c, values[i] ?? '']));
    });
    return { trades: rows.reverse() };
  }

  function serveStatic(pathname, res) {
    let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    rel = path.normalize(rel);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return send(res, 400, { error: 'caminho inválido' });
    const file = path.join(WEB_DIR, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'não encontrado' });
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    send(res, 200, fs.readFileSync(file), { 'Content-Type': type });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req, url)) return send(res, 401, { error: 'não autorizado' });
        if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, await status());
        if (req.method === 'GET' && url.pathname === '/api/trades') return send(res, 200, trades());
        if (req.method === 'POST' && url.pathname === '/api/close') {
          const body = await readBody(req);
          const symbol = String(body.symbol || '');
          if (!config.symbols.includes(symbol)) return send(res, 400, { error: 'símbolo desconhecido' });
          if (!broker.hasPosition(symbol)) return send(res, 409, { error: 'não há posição aberta nesse símbolo' });
          const result = await bot.closeManual(symbol);
          return send(res, 200, { ok: true, result });
        }
        if (req.method === 'POST' && url.pathname === '/api/pause') {
          bot.pause();
          logger.info('Painel: novas entradas PAUSADAS pelo usuário');
          return send(res, 200, { paused: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/resume') {
          bot.resume();
          logger.info('Painel: novas entradas RETOMADAS pelo usuário');
          return send(res, 200, { paused: false });
        }
        return send(res, 404, { error: 'rota desconhecida' });
      }
      serveStatic(url.pathname, res);
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info(`Painel: http://localhost:${port} | no celular use http://IP-deste-PC:${port}${token ? ' (protegido por token)' : ''}`);
  });
  return server;
}
