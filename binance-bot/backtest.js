// Backtest da estratégia com dados históricos da Binance (testnet).
// Usa exatamente as mesmas funções de sinal, risco e arredondamento do robô ao
// vivo (motor em src/backtestEngine.js — veja lá as convenções da simulação).
//
// Uso:
//   node backtest.js                          → 1º símbolo do config, 30 dias
//   node backtest.js --symbol ETHUSDT --days 60

import { loadConfig, INTERVALS } from './src/config.js';
import { BinanceFutures, extractFilters } from './src/binanceRest.js';
import { runBacktest } from './src/backtestEngine.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const config = loadConfig();
const symbol = arg('symbol', config.symbols[0]);
const days = Number(arg('days', 30));
config.paperStartBalance = Number(arg('balance', config.paperStartBalance));
const params = config.strategy;

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
if (candles.length < 300) {
  console.error(`Histórico insuficiente: ${candles.length} candles baixados. Tente menos dias ou outro símbolo.`);
  process.exit(1);
}
console.log(`${candles.length} candles baixados: pontuando a partir de ${new Date(windowStart).toISOString()}\n`);

const info = await client.exchangeInfo();
const filters = extractFilters(info, symbol);

const { trades, balance, startBalance, stats } = runBacktest({ candles, filters, config, windowStart });

console.log('================== RESULTADO DO BACKTEST ==================');
console.log(`Símbolo/tempo gráfico : ${symbol} ${config.interval} (${days} dias)`);
console.log(`Estratégia            : EMA${params.emaFast}/${params.emaSlow} + RSI${params.rsiPeriod} + ATR${params.atrPeriod}×${params.atrStopMult} (RR ${params.riskReward}:1${params.maxCandlesInTrade ? `, time-stop ${params.maxCandlesInTrade} candles` : ''})`);
console.log(`Risco por trade       : ${config.riskPerTradePct}% | alavancagem ${config.leverage}x | taxa ${config.takerFeePct}%`);
console.log('-----------------------------------------------------------');
console.log(`Operações             : ${stats.trades} (${stats.wins} ganhos / ${stats.trades - stats.wins} perdas)`);
console.log(`Taxa de acerto        : ${stats.winRate.toFixed(1)}%`);
console.log(`Fator de lucro        : ${Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'}`);
console.log(`Resultado líquido     : ${stats.netPnl >= 0 ? '+' : ''}${stats.netPnl.toFixed(2)} USDT (${stats.netPnlPct.toFixed(2)}%)`);
console.log(`Saldo final           : ${balance.toFixed(2)} USDT (inicial ${startBalance.toFixed(2)})`);
console.log(`Rebaixamento máximo   : ${stats.maxDrawdownPct.toFixed(2)}%`);
console.log(`Tempo médio na operação: ${stats.avgDurationMin.toFixed(0)} min`);
if (stats.blockedSignals) console.log(`Trava de perda diária : bloqueou ${stats.blockedSignals} sinal(is)`);
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
