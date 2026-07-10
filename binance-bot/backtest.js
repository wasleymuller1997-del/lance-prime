// Backtest da estratégia com dados históricos da Binance (testnet).
// Usa exatamente as mesmas funções de sinal, risco e arredondamento do robô ao vivo.
//
// Uso:
//   node backtest.js                          → 1º símbolo do config, 30 dias
//   node backtest.js --symbol ETHUSDT --days 60
//
// Convenções (conservadoras):
//   - entrada na ABERTURA do candle seguinte ao sinal (como no robô ao vivo)
//   - se o candle toca stop e alvo, assume que o STOP veio primeiro
//   - se o candle ABRE além do stop (gap), a saída é no preço do gap
//   - taxa taker cobrada na entrada e na saída
//   - 250 candles extras de aquecimento para os indicadores convergirem
//     (o robô ao vivo sempre analisa ~300 candles de histórico)

import { loadConfig, INTERVALS } from './src/config.js';
import { BinanceFutures, extractFilters } from './src/binanceRest.js';
import { computeSeries, signalAt, candlesNeeded } from './src/strategy.js';
import { computeQty, stopAndTarget } from './src/risk.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const config = loadConfig();
const symbol = arg('symbol', config.symbols[0]);
const days = Number(arg('days', 30));
const startBalance = Number(arg('balance', config.paperStartBalance));
const params = config.strategy;
const feeRate = config.takerFeePct / 100;

const client = new BinanceFutures({ network: 'testnet' });

const WARMUP_CANDLES = 250;
const intervalMs = INTERVALS[config.interval];
const windowStart = Date.now() - days * 86_400_000;

async function fetchHistory() {
  const end = Date.now();
  let start = windowStart - WARMUP_CANDLES * intervalMs;
  const out = [];
  while (start < end) {
    const batch = await client.klines(symbol, config.interval, { startTime: start, limit: 1500 });
    if (!batch.length) break;
    out.push(...batch);
    const next = batch[batch.length - 1].closeTime + 1;
    if (next <= start) break;
    start = next;
    if (batch.length < 1500) break;
  }
  // descarta o candle ainda em formação
  if (out.length && out[out.length - 1].closeTime > Date.now()) out.pop();
  return out;
}

console.log(`Baixando histórico de ${symbol} (${config.interval}, ${days} dias + aquecimento) da testnet...`);
const candles = await fetchHistory();
const need = candlesNeeded(params);

// só pontua o período pedido; o que veio antes é aquecimento dos indicadores
let startIdx = candles.findIndex((c) => c.openTime >= windowStart);
if (startIdx === -1) startIdx = candles.length;
startIdx = Math.max(startIdx, need);
if (candles.length - startIdx < 2) {
  console.error(`Histórico insuficiente: ${candles.length} candles baixados. Tente menos dias ou outro símbolo.`);
  process.exit(1);
}
console.log(`${candles.length} candles (${startIdx} de aquecimento): pontuando ${new Date(candles[startIdx].openTime).toISOString()} → ${new Date(candles[candles.length - 1].closeTime).toISOString()}\n`);

const info = await client.exchangeInfo();
const filters = extractFilters(info, symbol);
const series = computeSeries(candles, params);

let balance = startBalance;
let position = null;
let pendingSignal = null;
const trades = [];
let peak = startBalance;
let maxDrawdownPct = 0;

// Mesmas proteções do robô ao vivo: intervalo entre operações e trava diária.
let cooldownUntil = 0;
let dayKey = null;
let dayStartBalance = startBalance;
let daysBlocked = 0;

function closePosition(exitPrice, motivo, when) {
  const gross = position.side === 'long'
    ? (exitPrice - position.entryPrice) * position.qty
    : (position.entryPrice - exitPrice) * position.qty;
  const exitFee = exitPrice * position.qty * feeRate;
  balance += gross - exitFee;
  const netPnl = gross - exitFee - position.entryFee;
  trades.push({ ...position, exitPrice, motivo, netPnl, closedAt: when });
  position = null;
  cooldownUntil = when + config.cooldownMinutes * 60_000;
  peak = Math.max(peak, balance);
  maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - balance) / peak) * 100);
}

for (let i = startIdx; i < candles.length; i++) {
  const candle = candles[i];

  const today = new Date(candle.openTime).toISOString().slice(0, 10);
  if (dayKey !== today) {
    dayKey = today;
    dayStartBalance = balance;
  }
  const circuitBroken = balance <= dayStartBalance * (1 - config.maxDailyLossPct / 100);
  if (circuitBroken && pendingSignal) {
    pendingSignal = null;
    daysBlocked += 1;
  }

  // 1) Sinal do candle anterior executa na abertura deste.
  if (pendingSignal && !position) {
    const entryPrice = candle.open;
    const sized = computeQty({
      balance,
      price: entryPrice,
      stopDistance: pendingSignal.stopDistance,
      riskPct: config.riskPerTradePct,
      leverage: config.leverage,
      feeRate,
      filters,
    });
    if (sized.qty) {
      const { sl, tp } = stopAndTarget({
        side: pendingSignal.signal,
        entryPrice,
        stopDistance: pendingSignal.stopDistance,
        riskReward: params.riskReward,
        filters,
      });
      const entryFee = sized.qty * entryPrice * feeRate;
      balance -= entryFee;
      position = { side: pendingSignal.signal, qty: sized.qty, entryPrice, sl, tp, entryFee, openedAt: candle.openTime, reason: pendingSignal.reason };
      cooldownUntil = candle.openTime + config.cooldownMinutes * 60_000;
    }
    pendingSignal = null;
  }

  // 2) Stop/alvo dentro do candle (pessimista: stop primeiro; gap na abertura
  //    além do stop sai no preço do gap, como uma ordem stop de verdade).
  if (position) {
    if (position.side === 'long') {
      if (candle.low <= position.sl) closePosition(Math.min(position.sl, candle.open), 'stop', candle.closeTime);
      else if (candle.high >= position.tp) closePosition(position.tp, 'alvo', candle.closeTime);
    } else {
      if (candle.high >= position.sl) closePosition(Math.max(position.sl, candle.open), 'stop', candle.closeTime);
      else if (candle.low <= position.tp) closePosition(position.tp, 'alvo', candle.closeTime);
    }
  }

  // 3) Sinal no fechamento deste candle.
  const res = signalAt(candles, series, i, params);
  if (position && config.closeOnOppositeSignal) {
    const contrario = (position.side === 'long' && res.crossedDown) || (position.side === 'short' && res.crossedUp);
    if (contrario) closePosition(candle.close, 'cruzamento contrário', candle.closeTime);
  }
  if (!position && res.signal && candle.closeTime >= cooldownUntil && !circuitBroken) pendingSignal = res;
}
if (position) closePosition(candles[candles.length - 1].close, 'fim do backtest', candles[candles.length - 1].closeTime);

// ---------- Relatório ----------
const wins = trades.filter((t) => t.netPnl > 0);
const losses = trades.filter((t) => t.netPnl <= 0);
const grossWin = wins.reduce((s, t) => s + t.netPnl, 0);
const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
const netTotal = balance - startBalance;

console.log('================== RESULTADO DO BACKTEST ==================');
console.log(`Símbolo/tempo gráfico : ${symbol} ${config.interval} (${days} dias)`);
console.log(`Estratégia            : EMA${params.emaFast}/${params.emaSlow} + RSI${params.rsiPeriod} + ATR${params.atrPeriod}×${params.atrStopMult} (RR ${params.riskReward}:1)`);
console.log(`Risco por trade       : ${config.riskPerTradePct}% | alavancagem ${config.leverage}x | taxa ${config.takerFeePct}%`);
console.log('-----------------------------------------------------------');
console.log(`Operações             : ${trades.length} (${wins.length} ganhos / ${losses.length} perdas)`);
console.log(`Taxa de acerto        : ${trades.length ? ((wins.length / trades.length) * 100).toFixed(1) : '0.0'}%`);
console.log(`Fator de lucro        : ${grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? '∞' : '—')}`);
console.log(`Resultado líquido     : ${netTotal >= 0 ? '+' : ''}${netTotal.toFixed(2)} USDT (${((netTotal / startBalance) * 100).toFixed(2)}%)`);
console.log(`Saldo final           : ${balance.toFixed(2)} USDT (inicial ${startBalance.toFixed(2)})`);
console.log(`Rebaixamento máximo   : ${maxDrawdownPct.toFixed(2)}%`);
if (daysBlocked) console.log(`Trava de perda diária : bloqueou ${daysBlocked} sinal(is)`);
console.log('===========================================================');

if (trades.length) {
  console.log('\nÚltimas operações:');
  for (const t of trades.slice(-10)) {
    const sinal = t.netPnl >= 0 ? '+' : '';
    console.log(`  ${new Date(t.closedAt).toISOString().slice(0, 16)} ${t.side.toUpperCase().padEnd(5)} entrada ${t.entryPrice} → saída ${t.exitPrice} (${t.motivo}) ${sinal}${t.netPnl.toFixed(2)} USDT`);
  }
} else {
  console.log('\nNenhuma operação no período — a estratégia não encontrou entradas com esses parâmetros.');
}
