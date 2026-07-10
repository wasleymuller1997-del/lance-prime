// Indicadores técnicos. Todos recebem séries e retornam arrays alinhados à
// entrada, com null nas posições em que ainda não há dados suficientes.

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period; // semente: SMA dos primeiros `period` valores
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// RSI com suavização de Wilder (a mesma usada pela Binance/TradingView).
export function rsi(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (period < 1 || closes.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ATR com suavização de Wilder. Candles: [{ high, low, close }].
export function atr(candles, period) {
  const out = new Array(candles.length).fill(null);
  if (period < 1 || candles.length < period + 1) return out;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let prev = sum / period;
  out[period] = prev; // trs[period-1] pertence ao candle de índice `period`
  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i + 1] = prev;
  }
  return out;
}
