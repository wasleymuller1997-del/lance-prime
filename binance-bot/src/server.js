import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { buildStatus, readTrades } from './status.js';

const WEB_DIR = path.join(ROOT, 'web');

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
        if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, await buildStatus({ bot, broker, client, config }));
        if (req.method === 'GET' && url.pathname === '/api/trades') return send(res, 200, { trades: readTrades(config) });
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
