import { computeSeries, signalAt, candlesNeeded } from './strategy.js';
import { computeQty, stopAndTarget } from './risk.js';

// Motor de backtest: executa a estratégia sobre uma série de candles e devolve
// operações e estatísticas. Usa o MESMO código de sinal/risco do robô ao vivo
// e as mesmas convenções conservadoras:
//   - entrada na abertura do candle seguinte ao sinal
//   - stop vence quando o candle toca stop e alvo no mesmo candle
//   - gap além do stop sai no preço do gap
//   - taxas de entrada e saída; cooldown e trava diária simulados
//   - time-stop opcional (strategy.maxCandlesInTrade) fecha por tempo
export function runBacktest({ candles, filters, config, windowStart = -Infinity }) {
  const params = config.strategy;
  const feeRate = config.takerFeePct / 100;
  const series = computeSeries(candles, params);
  const need = candlesNeeded(params);

  let startIdx = candles.findIndex((c) => c.openTime >= windowStart);
  if (startIdx === -1) startIdx = candles.length;
  startIdx = Math.max(startIdx, need);

  const startBalance = config.paperStartBalance;
  let balance = startBalance;
  let position = null;
  let pendingSignal = null;
  const trades = [];
  let peak = startBalance;
  let maxDrawdownPct = 0;
  let cooldownUntil = 0;
  let dayKey = null;
  let dayStartBalance = startBalance;
  let blockedSignals = 0;

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
      blockedSignals += 1;
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
        position = {
          side: pendingSignal.signal,
          qty: sized.qty,
          entryPrice,
          sl,
          tp,
          entryFee,
          openedAt: candle.openTime,
          entryIndex: i,
          reason: pendingSignal.reason,
        };
        cooldownUntil = candle.openTime + config.cooldownMinutes * 60_000;
      }
      pendingSignal = null;
    }

    // 2) Stop/alvo dentro do candle (pessimista; gap sai no preço do gap).
    if (position) {
      if (position.side === 'long') {
        if (candle.low <= position.sl) closePosition(Math.min(position.sl, candle.open), 'stop', candle.closeTime);
        else if (candle.high >= position.tp) closePosition(position.tp, 'alvo', candle.closeTime);
      } else {
        if (candle.high >= position.sl) closePosition(Math.max(position.sl, candle.open), 'stop', candle.closeTime);
        else if (candle.low <= position.tp) closePosition(position.tp, 'alvo', candle.closeTime);
      }
    }

    // 3) Time-stop: sai por tempo depois de N candles na operação.
    if (position && params.maxCandlesInTrade > 0 && i - position.entryIndex >= params.maxCandlesInTrade) {
      closePosition(candle.close, 'tempo', candle.closeTime);
    }

    // 4) Sinal no fechamento deste candle.
    const res = signalAt(candles, series, i, params);
    if (position && config.closeOnOppositeSignal) {
      const contrario = (position.side === 'long' && res.crossedDown) || (position.side === 'short' && res.crossedUp);
      if (contrario) closePosition(candle.close, 'cruzamento contrário', candle.closeTime);
    }
    if (!position && res.signal && candle.closeTime >= cooldownUntil && !circuitBroken) pendingSignal = res;
  }
  if (position) closePosition(candles[candles.length - 1].close, 'fim do backtest', candles[candles.length - 1].closeTime);

  const wins = trades.filter((t) => t.netPnl > 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.netPnl <= 0).reduce((s, t) => s + t.netPnl, 0));
  const durations = trades.map((t) => t.closedAt - t.openedAt);

  return {
    trades,
    balance,
    startBalance,
    stats: {
      trades: trades.length,
      wins: wins.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      netPnl: balance - startBalance,
      netPnlPct: ((balance - startBalance) / startBalance) * 100,
      maxDrawdownPct,
      avgDurationMin: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length / 60_000 : 0,
      blockedSignals,
    },
  };
}
