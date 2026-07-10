import fs from 'node:fs';
import path from 'node:path';
import { ROOT, INTERVALS } from './config.js';
import { STRATEGY_LABELS } from './strategy.js';

const DATA_DIR = path.join(ROOT, 'data');

// Monta o retrato atual do robô (saldo, dia, posições com PnL ao vivo).
// Usado pelo painel local (src/server.js) e pelo relay do site (src/relay.js).
export async function buildStatus({ bot, broker, client, config }) {
  const balance = await broker.balanceForRisk();
  const dayStart = broker.state?.dayStartBalance ?? broker.dayStartBalance ?? balance;
  const feeRate = config.takerFeePct / 100;
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
    // PnL LÍQUIDO: o que realmente entra no bolso se encerrar agora —
    // taxa de entrada (já paga) + taxa de saída estimada descontadas.
    const entryFee = pos.entryFee ?? pos.entryPrice * pos.qty * feeRate;
    const exitFee = mark * pos.qty * feeRate;
    const net = gross - entryFee - exitFee;
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
      pnl: net,
      pnlGross: gross,
      fees: entryFee + exitFee,
      pnlPct: margin > 0 ? (net / margin) * 100 : 0,
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
      type: config.strategy.type || 'ema-cross',
      label: STRATEGY_LABELS[config.strategy.type || 'ema-cross'] || config.strategy.type,
      emaFast: config.strategy.emaFast,
      emaSlow: config.strategy.emaSlow,
      rsiLongMin: config.strategy.rsiLongMin,
      rsiLongMax: config.strategy.rsiLongMax,
      rsiShortMin: config.strategy.rsiShortMin,
      rsiShortMax: config.strategy.rsiShortMax,
    },
    riskPerTradePct: config.riskPerTradePct,
    paused: bot.paused,
    balance,
    dayPnl: balance - dayStart,
    positions,
    market,
    events: (bot.events || []).slice(0, 15),
    updatedAt: Date.now(),
  };
}

// Últimas operações a partir do CSV do modo atual (mais recentes primeiro).
// `id` aponta pro arquivo da instância certa quando várias rodam juntas.
export function readTrades(config, limit = 30, id = null) {
  const base = config.mode === 'paper' ? `trades${id ? `-${id}` : ''}.csv` : 'trades-testnet.csv';
  const file = path.join(DATA_DIR, base);
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
