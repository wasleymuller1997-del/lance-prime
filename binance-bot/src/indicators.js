// Indicadores técnicos. Todos recebem séries e retornam arrays alinhados à
// entrada, com null nas posições em que ainda não há dados suficientes.

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || values.length < period) return out;
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
  if (!Number.isInteger(period) || period < 1 || closes.length < period + 1) return out;
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

// ADX com suavização de Wilder — mede a FORÇA da tendência (0-100):
// abaixo de ~20 o mercado está lateral; acima, tendendo.
export function adx(candles, period) {
  const out = new Array(candles.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || candles.length < period * 2 + 1) return out;
  const plusDM = [];
  const minusDM = [];
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    const c = candles[i];
    const pc = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
  }
  // suavização de Wilder das três séries
  let sTR = 0;
  let sPlus = 0;
  let sMinus = 0;
  for (let i = 0; i < period; i++) {
    sTR += trs[i];
    sPlus += plusDM[i];
    sMinus += minusDM[i];
  }
  const dxs = [];
  for (let i = period; i <= trs.length; i++) {
    const plusDI = sTR > 0 ? (100 * sPlus) / sTR : 0;
    const minusDI = sTR > 0 ? (100 * sMinus) / sTR : 0;
    const soma = plusDI + minusDI;
    dxs.push(soma > 0 ? (100 * Math.abs(plusDI - minusDI)) / soma : 0);
    if (i < trs.length) {
      sTR = sTR - sTR / period + trs[i];
      sPlus = sPlus - sPlus / period + plusDM[i];
      sMinus = sMinus - sMinus / period + minusDM[i];
    }
  }
  // ADX = média de Wilder dos DX; dxs[0] corresponde ao candle index `period`
  let acc = 0;
  for (let i = 0; i < period && i < dxs.length; i++) acc += dxs[i];
  if (dxs.length < period) return out;
  let prev = acc / period;
  out[period * 2 - 1] = prev; // primeiro ADX no candle period*2-1 (aprox. convenção Wilder)
  for (let i = period; i < dxs.length; i++) {
    prev = (prev * (period - 1) + dxs[i]) / period;
    out[period + i] = prev;
  }
  return out;
}

// ATR com suavização de Wilder. Candles: [{ high, low, close }].
export function atr(candles, period) {
  const out = new Array(candles.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || candles.length < period + 1) return out;
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
