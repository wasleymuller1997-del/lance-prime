import { ema, rsi, atr } from './indicators.js';

// Estratégia: cruzamento de EMAs com filtro de RSI e stop baseado em ATR.
//
// Entrada LONG : EMA rápida cruza pra CIMA da lenta e RSI entre rsiLongMin e rsiLongMax
// Entrada SHORT: EMA rápida cruza pra BAIXO da lenta e RSI entre rsiShortMin e rsiShortMax
// Stop  : atrStopMult × ATR abaixo/acima da entrada
// Alvo  : riskReward × distância do stop
//
// As mesmas funções servem o robô ao vivo (último candle) e o backtest (qualquer índice),
// garantindo que o que foi testado é exatamente o que roda em produção.

export function candlesNeeded(params) {
  return Math.max(params.emaSlow, params.rsiPeriod + 1, params.atrPeriod + 1) + 1;
}

export function computeSeries(candles, params) {
  const closes = candles.map((c) => c.close);
  return {
    fast: ema(closes, params.emaFast),
    slow: ema(closes, params.emaSlow),
    rsi: rsi(closes, params.rsiPeriod),
    atr: atr(candles, params.atrPeriod),
  };
}

// Avalia o sinal no fechamento do candle de índice `i`.
export function signalAt(candles, series, i, params) {
  const { fast, slow, rsi: r, atr: a } = series;
  if (i < 1 || fast[i - 1] == null || slow[i - 1] == null || fast[i] == null || slow[i] == null || r[i] == null || a[i] == null) {
    return { signal: null, reason: 'dados insuficientes para calcular os indicadores' };
  }

  const crossedUp = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
  const crossedDown = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
  const snapshot = {
    close: candles[i].close,
    emaFast: fast[i],
    emaSlow: slow[i],
    rsi: r[i],
    atr: a[i],
    trend: fast[i] > slow[i] ? 'alta' : 'baixa',
  };
  const base = { signal: null, crossedUp, crossedDown, snapshot, stopDistance: a[i] * params.atrStopMult };

  if (crossedUp && r[i] >= params.rsiLongMin && r[i] <= params.rsiLongMax) {
    return {
      ...base,
      signal: 'long',
      reason: `EMA${params.emaFast} cruzou acima da EMA${params.emaSlow} com RSI ${r[i].toFixed(1)}`,
    };
  }
  if (crossedDown && r[i] >= params.rsiShortMin && r[i] <= params.rsiShortMax) {
    return {
      ...base,
      signal: 'short',
      reason: `EMA${params.emaFast} cruzou abaixo da EMA${params.emaSlow} com RSI ${r[i].toFixed(1)}`,
    };
  }

  let reason = `tendência de ${snapshot.trend}, sem cruzamento`;
  if (crossedUp) reason = `cruzamento de alta descartado: RSI ${r[i].toFixed(1)} fora da faixa [${params.rsiLongMin}, ${params.rsiLongMax}]`;
  if (crossedDown) reason = `cruzamento de baixa descartado: RSI ${r[i].toFixed(1)} fora da faixa [${params.rsiShortMin}, ${params.rsiShortMax}]`;
  return { ...base, reason };
}

// Atalho para o robô ao vivo: avalia o último candle FECHADO da série.
export function analyze(candles, params) {
  if (candles.length < candlesNeeded(params)) {
    return { signal: null, reason: 'dados insuficientes para calcular os indicadores' };
  }
  const series = computeSeries(candles, params);
  return signalAt(candles, series, candles.length - 1, params);
}
