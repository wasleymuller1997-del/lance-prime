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
  const takerFee = config.takerFeePct / 100;
  const makerFee = (config.makerFeePct ?? 0.02) / 100;
  const maker = config.entryMode === 'maker'; // entrada e alvo como ordem limitada
  const entryFeeRate = maker ? makerFee : takerFee;
  // dimensionamento conservador: taxa média por perna considerando saída no stop (taker)
  const feeRate = (entryFeeRate + takerFee) / 2;
  const series = computeSeries(candles, params);
  const need = candlesNeeded(params);

  let startIdx = candles.findIndex((c) => c.openTime >= windowStart);
  if (startIdx === -1) startIdx = candles.length;
  startIdx = Math.max(startIdx, need);

  const startBalance = config.paperStartBalance;
  let balance = startBalance;
  let position = null;
  let pendingSignal = null;
  let pendingLimit = null; // ordem limitada aguardando preenchimento (modo maker)
  let missedEntries = 0;
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
    // alvo sai como ordem limitada (maker) quando o modo maker está ligado;
    // stop e demais saídas são sempre a mercado (taker)
    const exitFeeRate = maker && motivo === 'alvo' ? makerFee : takerFee;
    const exitFee = exitPrice * position.qty * exitFeeRate;
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
    if (circuitBroken && (pendingSignal || pendingLimit)) {
      pendingSignal = null;
      pendingLimit = null;
      blockedSignals += 1;
    }

    // Abre a posição no preço/candle indicados (taxa de entrada conforme o modo).
    function openPosition(side, entryPrice, stopDistance, reason) {
      const sized = computeQty({
        balance,
        price: entryPrice,
        stopDistance,
        riskPct: config.riskPerTradePct,
        leverage: config.leverage,
        feeRate,
        filters,
      });
      if (!sized.qty) return false;
      const { sl, tp } = stopAndTarget({ side, entryPrice, stopDistance, riskReward: params.riskReward, filters });
      const entryFee = sized.qty * entryPrice * entryFeeRate;
      balance -= entryFee;
      position = {
        side,
        qty: sized.qty,
        entryPrice,
        sl,
        tp,
        riskPerUnit: stopDistance,
        entryFee,
        openedAt: candle.openTime,
        entryIndex: i,
        reason,
      };
      cooldownUntil = candle.openTime + config.cooldownMinutes * 60_000;
      return true;
    }

    // 1) Execução do sinal do candle anterior.
    if (maker) {
      // modo maker: vira ordem limitada no preço do fechamento do sinal…
      if (pendingSignal && !position && !pendingLimit) {
        pendingLimit = {
          side: pendingSignal.signal,
          limitPrice: pendingSignal.snapshot?.close ?? candle.open,
          stopDistance: pendingSignal.stopDistance,
          reason: pendingSignal.reason,
          waitLeft: config.makerWaitCandles ?? 2,
        };
        pendingSignal = null;
      }
      // …que só preenche se o preço ATRAVESSAR o nível (tocar não garante
      // execução — há fila no livro); senão expira = entrada perdida
      if (pendingLimit && !position) {
        const p = pendingLimit;
        const touched = p.side === 'long' ? candle.low < p.limitPrice : candle.high > p.limitPrice;
        if (touched) {
          const entryPrice = p.side === 'long' ? Math.min(candle.open, p.limitPrice) : Math.max(candle.open, p.limitPrice);
          openPosition(p.side, entryPrice, p.stopDistance, p.reason);
          pendingLimit = null;
        } else if (--p.waitLeft <= 0) {
          pendingLimit = null;
          missedEntries += 1;
        }
      }
    } else if (pendingSignal && !position) {
      // modo taker: entra a mercado na abertura deste candle
      openPosition(pendingSignal.signal, candle.open, pendingSignal.stopDistance, pendingSignal.reason);
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

    // 3b) Proteção de lucro no fechamento do candle: breakeven, trailing e
    //     trava perto do alvo (o stop só anda a favor, nunca alarga).
    if (position && (params.breakEvenAtR > 0 || params.trailAtrMult > 0 || params.lockAtTargetPct > 0)) {
      const risk = position.riskPerUnit;
      const atrNow = series.atr[i];
      const alcance = position.tp - position.entryPrice; // sinalizado (negativo no short)
      const progresso = alcance !== 0 ? (candle.close - position.entryPrice) / alcance : 0;
      if (position.side === 'long') {
        if (params.breakEvenAtR > 0 && candle.close >= position.entryPrice + risk * params.breakEvenAtR) {
          position.sl = Math.max(position.sl, position.entryPrice);
        }
        if (params.trailAtrMult > 0 && atrNow != null) {
          position.sl = Math.max(position.sl, candle.close - atrNow * params.trailAtrMult);
        }
        if (params.lockAtTargetPct > 0 && progresso >= params.lockAtTargetPct / 100) {
          position.sl = Math.max(position.sl, position.entryPrice + alcance * (params.lockKeepTargetPct / 100));
        }
      } else {
        if (params.breakEvenAtR > 0 && candle.close <= position.entryPrice - risk * params.breakEvenAtR) {
          position.sl = Math.min(position.sl, position.entryPrice);
        }
        if (params.trailAtrMult > 0 && atrNow != null) {
          position.sl = Math.min(position.sl, candle.close + atrNow * params.trailAtrMult);
        }
        if (params.lockAtTargetPct > 0 && progresso >= params.lockAtTargetPct / 100) {
          position.sl = Math.min(position.sl, position.entryPrice + alcance * (params.lockKeepTargetPct / 100));
        }
      }
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
      missedEntries,
    },
  };
}
