import fs from 'node:fs';
import path from 'node:path';
import { ROOT, INTERVALS } from './config.js';

const DATA_DIR = path.join(ROOT, 'data');

// Monta o retrato atual do robô (saldo, dia, posições com PnL ao vivo).
// Usado pelo painel local (src/server.js) e pelo relay do site (src/relay.js).
export async function buildStatus({ bot, broker, client, config }) {
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
  // Análise ao vivo de cada símbolo (indicadores, motivo, mini-gráfico) —
  // é o que o painel mostra enquanto não há posição aberta.
  const market = config.symbols.map((symbol) => ({
    symbol,
    price: bot.lastPrices?.[symbol]?.price ?? null,
    analysis: bot.lastAnalysis?.[symbol] ?? null,
    spark: bot.lastCandles?.[symbol] ?? [],
  }));

  return {
    mode: config.mode,
    symbols: config.symbols,
    interval: config.interval,
    intervalMs: INTERVALS[config.interval],
    leverage: config.leverage,
    strategy: {
      emaFast: config.strategy.emaFast,
      emaSlow: config.strategy.emaSlow,
      rsiLongMin: config.strategy.rsiLongMin,
      rsiLongMax: config.strategy.rsiLongMax,
      rsiShortMin: config.strategy.rsiShortMin,
      rsiShortMax: config.strategy.rsiShortMax,
    },
    paused: bot.paused,
    balance,
    dayPnl: balance - dayStart,
    positions,
    market,
    updatedAt: Date.now(),
  };
}

// Últimas operações a partir do CSV do modo atual (mais recentes primeiro).
export function readTrades(config, limit = 30) {
  const file = path.join(DATA_DIR, config.mode === 'paper' ? 'trades.csv' : 'trades-testnet.csv');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const cols = lines[0].split(',');
  return lines
    .slice(1)
    .slice(-limit)
    .map((line) => {
      const values = line.split(',');
      return Object.fromEntries(cols.map((c, i) => [c, values[i] ?? '']));
    })
    .reverse();
}
