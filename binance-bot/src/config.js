import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const INTERVALS = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
};

// Carrega variáveis de um .env simples (KEY=VALOR), sem sobrescrever o ambiente.
function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Um campo numérico faltando ou digitado errado desligaria silenciosamente uma
// proteção (comparações com NaN/undefined são sempre false) — por isso o robô
// se recusa a iniciar com configuração inválida.
function assertNumber(config, keyPath, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const value = keyPath.split('.').reduce((obj, k) => (obj == null ? undefined : obj[k]), config);
  const ok =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    (!integer || Number.isInteger(value));
  if (!ok) {
    throw new Error(`config.json: "${keyPath}" deve ser um número${integer ? ' inteiro' : ''} entre ${min} e ${max} (recebido: ${JSON.stringify(value)})`);
  }
}

export function loadConfig() {
  loadDotEnv();
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

  config.mode = (process.env.BOT_MODE || config.mode || 'paper').toLowerCase();
  if (!['paper', 'testnet'].includes(config.mode)) {
    throw new Error(`modo inválido: ${config.mode} (use "paper" ou "testnet")`);
  }
  config.apiKey = process.env.BINANCE_API_KEY || '';
  config.apiSecret = process.env.BINANCE_API_SECRET || '';

  if (!Array.isArray(config.symbols) || config.symbols.length === 0 || !config.symbols.every((s) => typeof s === 'string' && /^[A-Z0-9]+$/.test(s))) {
    throw new Error('config.json: "symbols" precisa ser uma lista de símbolos em maiúsculas (ex.: ["BTCUSDT"])');
  }
  if (!INTERVALS[config.interval]) {
    throw new Error(`config.json: "interval" inválido: ${config.interval} (use ${Object.keys(INTERVALS).join(', ')})`);
  }
  if (typeof config.closeOnOppositeSignal !== 'boolean') {
    throw new Error('config.json: "closeOnOppositeSignal" deve ser true ou false');
  }
  if (!['ISOLATED', 'CROSSED'].includes(config.marginType)) {
    throw new Error('config.json: "marginType" deve ser ISOLATED ou CROSSED');
  }

  assertNumber(config, 'pollSeconds', { min: 5, max: 3600, integer: true });
  assertNumber(config, 'leverage', { min: 1, max: 125, integer: true });
  assertNumber(config, 'riskPerTradePct', { min: 0.01, max: 100 });
  assertNumber(config, 'maxOpenPositions', { min: 1, max: 50, integer: true });
  assertNumber(config, 'maxDailyLossPct', { min: 0.1, max: 100 });
  assertNumber(config, 'cooldownMinutes', { min: 0, max: 10_080 });
  assertNumber(config, 'paperStartBalance', { min: 1, max: 1e12 });
  assertNumber(config, 'takerFeePct', { min: 0, max: 5 });
  // Execução: taker = ordem a mercado (entra sempre, taxa cheia);
  // maker = ordem limitada no livro (taxa menor, mas pode perder a entrada).
  config.entryMode ??= 'taker';
  if (!['taker', 'maker'].includes(config.entryMode)) {
    throw new Error(`config.json: "entryMode" inválido: ${config.entryMode} (use taker ou maker)`);
  }
  config.makerFeePct ??= 0.02;
  assertNumber(config, 'makerFeePct', { min: 0, max: 5 });
  config.makerWaitCandles ??= 2;
  assertNumber(config, 'makerWaitCandles', { min: 1, max: 50, integer: true });
  config.dashboardPort ??= 8484;
  assertNumber(config, 'dashboardPort', { min: 1, max: 65535, integer: true });
  config.strategy.type ??= 'ema-cross';
  if (!['ema-cross', 'rsi-reversao', 'rompimento'].includes(config.strategy.type)) {
    throw new Error(`config.json: strategy.type inválido: ${config.strategy.type} (use ema-cross, rsi-reversao ou rompimento)`);
  }
  config.strategy.breakoutPeriod ??= 20;
  assertNumber(config, 'strategy.breakoutPeriod', { min: 2, max: 500, integer: true });
  for (const key of ['emaFast', 'emaSlow', 'rsiPeriod', 'atrPeriod']) {
    assertNumber(config, `strategy.${key}`, { min: 1, max: 500, integer: true });
  }
  for (const key of ['rsiLongMin', 'rsiLongMax', 'rsiShortMin', 'rsiShortMax']) {
    assertNumber(config, `strategy.${key}`, { min: 0, max: 100 });
  }
  assertNumber(config, 'strategy.atrStopMult', { min: 0.1, max: 100 });
  assertNumber(config, 'strategy.riskReward', { min: 0.1, max: 100 });
  config.strategy.maxCandlesInTrade ??= 0; // 0 = sem limite de tempo
  assertNumber(config, 'strategy.maxCandlesInTrade', { min: 0, max: 1000, integer: true });
  // Proteção de lucro (0 = desligado):
  // breakEvenAtR: com lucro de N× o risco, stop vai pro preço de entrada
  // trailAtrMult: stop persegue o preço a N× ATR de distância (só aperta)
  config.strategy.breakEvenAtR ??= 0;
  assertNumber(config, 'strategy.breakEvenAtR', { min: 0, max: 100 });
  config.strategy.trailAtrMult ??= 0;
  assertNumber(config, 'strategy.trailAtrMult', { min: 0, max: 100 });
  if (config.strategy.emaFast >= config.strategy.emaSlow) {
    throw new Error('config.json: strategy.emaFast deve ser menor que strategy.emaSlow');
  }

  // Variantes (multi-robô, um por tempo gráfico) — opcional, só no modo paper.
  if (config.variants != null) {
    if (!Array.isArray(config.variants) || config.variants.length === 0 || config.variants.length > 8) {
      throw new Error('config.json: "variants" deve ser uma lista com 1 a 8 itens');
    }
    const ids = new Set();
    for (const v of config.variants) {
      if (!v || typeof v.id !== 'string' || !/^[a-z0-9-]+$/i.test(v.id) || ids.has(v.id)) {
        throw new Error('config.json: cada variante precisa de um "id" único (letras/números)');
      }
      ids.add(v.id);
      if (!INTERVALS[v.interval]) {
        throw new Error(`config.json: variante ${v.id} tem "interval" inválido: ${v.interval}`);
      }
      if (v.cooldownMinutes != null && (typeof v.cooldownMinutes !== 'number' || !(v.cooldownMinutes >= 0))) {
        throw new Error(`config.json: variante ${v.id} tem "cooldownMinutes" inválido`);
      }
      if (v.riskPerTradePct != null && (typeof v.riskPerTradePct !== 'number' || !(v.riskPerTradePct > 0 && v.riskPerTradePct <= 100))) {
        throw new Error(`config.json: variante ${v.id} tem "riskPerTradePct" inválido`);
      }
      if (v.leverage != null && (!Number.isInteger(v.leverage) || v.leverage < 1 || v.leverage > 125)) {
        throw new Error(`config.json: variante ${v.id} tem "leverage" inválido`);
      }
      if (v.strategy != null && (typeof v.strategy !== 'object' || (v.strategy.type && !['ema-cross', 'rsi-reversao', 'rompimento'].includes(v.strategy.type)))) {
        throw new Error(`config.json: variante ${v.id} tem "strategy" inválida`);
      }
      if (v.symbols != null && (!Array.isArray(v.symbols) || v.symbols.length === 0 || !v.symbols.every((s) => typeof s === 'string' && /^[A-Z0-9]+$/.test(s)))) {
        throw new Error(`config.json: variante ${v.id} tem "symbols" inválidos`);
      }
      if (v.maxOpenPositions != null && (!Number.isInteger(v.maxOpenPositions) || v.maxOpenPositions < 1 || v.maxOpenPositions > 50)) {
        throw new Error(`config.json: variante ${v.id} tem "maxOpenPositions" inválido`);
      }
    }
  }

  return config;
}
