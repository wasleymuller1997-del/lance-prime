// Varredura de parâmetros: testa milhares de combinações da estratégia em
// dados históricos e ranqueia as melhores, exigindo lucro em DOIS períodos
// (treino e validação) e nos DOIS símbolos — proteção contra "sorte de curva".
//
// Uso:
//   node sweep.js                     → 60 dias, símbolos do config
//   node sweep.js --days 90 --top 15

import { loadConfig, INTERVALS } from './src/config.js';
import { BinanceFutures, extractFilters } from './src/binanceRest.js';
import { runBacktest } from './src/backtestEngine.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const config = loadConfig();
const days = Number(arg('days', 60));
const top = Number(arg('top', 12));
const symbols = arg('symbols', config.symbols.join(',')).split(',');

const GRID = {
  interval: ['5m', '15m', '30m', '1h'],
  emaPair: [[9, 21], [12, 26], [8, 34], [20, 50]],
  rsiBand: [
    { nome: 'padrao', rsiLongMin: 50, rsiLongMax: 70, rsiShortMin: 30, rsiShortMax: 50 },
    { nome: 'largo', rsiLongMin: 45, rsiLongMax: 80, rsiShortMin: 20, rsiShortMax: 55 },
    { nome: 'sem', rsiLongMin: 0, rsiLongMax: 100, rsiShortMin: 0, rsiShortMax: 100 },
  ],
  atrStopMult: [1, 1.5, 2],
  riskReward: [1.5, 2, 3],
  closeOnOppositeSignal: [true, false],
  maxCandlesInTrade: [0, 8, 16],
};

const WARMUP_CANDLES = 250;
const now = Date.now();
const windowStart = now - days * 86_400_000;
const valStart = now - Math.round((days / 3)) * 86_400_000; // último 1/3 = validação

const client = new BinanceFutures({ network: 'testnet' });

async function fetchHistory(symbol, interval) {
  const intervalMs = INTERVALS[interval];
  let start = windowStart - WARMUP_CANDLES * intervalMs;
  const out = [];
  while (start < now) {
    const batch = await client.klines(symbol, interval, { startTime: start, limit: 1500 });
    if (!batch.length) break;
    out.push(...batch);
    const next = batch[batch.length - 1].closeTime + 1;
    if (next <= start) break;
    start = next;
    if (batch.length < 1500) break;
  }
  if (out.length && out[out.length - 1].closeTime > Date.now()) out.pop();
  return out;
}

console.log(`Varredura: ${symbols.join(', ')} | ${days} dias (validação = últimos ${Math.round(days / 3)} dias)`);
const info = await client.exchangeInfo();
const filters = {};
const history = {}; // symbol → interval → candles
for (const symbol of symbols) {
  filters[symbol] = extractFilters(info, symbol);
  history[symbol] = {};
  for (const interval of GRID.interval) {
    history[symbol][interval] = await fetchHistory(symbol, interval);
    console.log(`  ${symbol} ${interval}: ${history[symbol][interval].length} candles`);
  }
}

let combos = 0;
const results = [];
for (const interval of GRID.interval) {
  for (const [emaFast, emaSlow] of GRID.emaPair) {
    for (const rsiBand of GRID.rsiBand) {
      for (const atrStopMult of GRID.atrStopMult) {
        for (const riskReward of GRID.riskReward) {
          for (const closeOnOppositeSignal of GRID.closeOnOppositeSignal) {
            for (const maxCandlesInTrade of GRID.maxCandlesInTrade) {
              combos += 1;
              const cfgRun = {
                ...config,
                interval,
                closeOnOppositeSignal,
                strategy: {
                  ...config.strategy,
                  emaFast,
                  emaSlow,
                  ...rsiBand,
                  atrStopMult,
                  riskReward,
                  maxCandlesInTrade,
                },
              };
              const bySymbol = {};
              let ok = true;
              for (const symbol of symbols) {
                const candles = history[symbol][interval];
                if (candles.length < 400) { ok = false; break; }
                // treino: início da janela até valStart | validação: valStart em diante
                const trainCandles = candles.filter((c) => c.closeTime <= valStart);
                const train = runBacktest({ candles: trainCandles, filters: filters[symbol], config: cfgRun, windowStart });
                const val = runBacktest({ candles, filters: filters[symbol], config: cfgRun, windowStart: valStart });
                bySymbol[symbol] = { train: train.stats, val: val.stats };
                // exigências mínimas de robustez
                if (train.stats.trades < 8 || val.stats.trades < 4) ok = false;
                if (train.stats.netPnlPct <= 0 || val.stats.netPnlPct <= 0) ok = false;
              }
              if (!ok) continue;
              const valPcts = symbols.map((s) => bySymbol[s].val.netPnlPct);
              const trainPcts = symbols.map((s) => bySymbol[s].train.netPnlPct);
              results.push({
                interval,
                emaFast,
                emaSlow,
                rsi: rsiBand.nome,
                atrStopMult,
                riskReward,
                closeOnOppositeSignal,
                maxCandlesInTrade,
                bySymbol,
                minValPct: Math.min(...valPcts),
                sumValPct: valPcts.reduce((a, b) => a + b, 0),
                sumTrainPct: trainPcts.reduce((a, b) => a + b, 0),
                avgDurationMin: symbols.reduce((a, s) => a + bySymbol[s].val.avgDurationMin, 0) / symbols.length,
                maxDD: Math.max(...symbols.map((s) => Math.max(bySymbol[s].train.maxDrawdownPct, bySymbol[s].val.maxDrawdownPct))),
                trades: symbols.reduce((a, s) => a + bySymbol[s].train.trades + bySymbol[s].val.trades, 0),
              });
            }
          }
        }
      }
    }
  }
}

// ranking: pior desempenho na validação primeiro (robustez), depois soma
results.sort((a, b) => b.minValPct - a.minValPct || b.sumValPct - a.sumValPct);

console.log(`\n${combos} combinações testadas | ${results.length} lucrativas em treino E validação nos ${symbols.length} símbolos\n`);
if (!results.length) {
  console.log('Nenhuma configuração passou nos critérios de robustez. Tente mais dias de histórico (--days 90).');
  process.exit(0);
}

const header = 'TF   EMAs   RSI     ATR  RR   contr timestop | PnL%treino  PnL%valid  DD%max  dur.média  ops';
console.log(header);
console.log('-'.repeat(header.length));
for (const r of results.slice(0, top)) {
  const treino = symbols.map((s) => `${s.replace('USDT', '')} ${r.bySymbol[s].train.netPnlPct >= 0 ? '+' : ''}${r.bySymbol[s].train.netPnlPct.toFixed(1)}`).join(' ');
  const valid = symbols.map((s) => `${s.replace('USDT', '')} ${r.bySymbol[s].val.netPnlPct >= 0 ? '+' : ''}${r.bySymbol[s].val.netPnlPct.toFixed(1)}`).join(' ');
  console.log(
    `${r.interval.padEnd(4)} ${(r.emaFast + '/' + r.emaSlow).padEnd(6)} ${r.rsi.padEnd(7)} ${String(r.atrStopMult).padEnd(4)} ${String(r.riskReward).padEnd(4)} ${(r.closeOnOppositeSignal ? 'sim' : 'não').padEnd(5)} ${String(r.maxCandlesInTrade || '—').padEnd(8)} | ${treino.padEnd(18)} ${valid.padEnd(18)} ${r.maxDD.toFixed(1).padStart(5)}  ${`${r.avgDurationMin.toFixed(0)}min`.padStart(8)}  ${String(r.trades).padStart(4)}`
  );
}

const best = results[0];
console.log('\nMelhor configuração (robusta nos dois períodos e símbolos):');
console.log(JSON.stringify({
  interval: best.interval,
  closeOnOppositeSignal: best.closeOnOppositeSignal,
  strategy: {
    emaFast: best.emaFast,
    emaSlow: best.emaSlow,
    rsiBanda: best.rsi,
    atrStopMult: best.atrStopMult,
    riskReward: best.riskReward,
    maxCandlesInTrade: best.maxCandlesInTrade,
  },
}, null, 2));
