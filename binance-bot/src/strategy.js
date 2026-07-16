import { ema, rsi, atr } from './indicators.js';

// Estratégias plugáveis — o mesmo código serve o robô ao vivo, o backtest e a
// varredura. O tipo vem de params.type:
//
//  ema-cross    (padrão) EMA rápida cruza a lenta + filtro de RSI
//  rsi-reversao compra exagero de queda / vende exagero de alta:
//               entra quando o RSI SAI da zona extrema (virada confirmada)
//  rompimento   entra quando o fechamento estoura a máxima/mínima das
//               últimas N velas (canal de Donchian)
//
// Stop: atrStopMult × ATR | Alvo: riskReward × distância do stop (todas).

export const STRATEGY_LABELS = {
  'ema-cross': 'Cruzamento de EMAs',
  'ema-pullback': 'Surf de tendência (pullback)',
  'rsi-reversao': 'Reversão por RSI',
  rompimento: 'Rompimento',
};

const typeOf = (params) => params.type || 'ema-cross';

export function candlesNeeded(params) {
  const common = Math.max(params.rsiPeriod + 1, params.atrPeriod + 1);
  switch (typeOf(params)) {
    case 'rsi-reversao':
      return common + 2;
    case 'rompimento':
      return Math.max(common, (params.breakoutPeriod || 20) + 1) + 1;
    default:
      return Math.max(params.emaSlow, params.emaFast, common) + 1;
  }
}

export function computeSeries(candles, params) {
  const closes = candles.map((c) => c.close);
  const series = {
    rsi: rsi(closes, params.rsiPeriod),
    atr: atr(candles, params.atrPeriod),
  };
  const t = typeOf(params);
  if (t === 'ema-cross' || t === 'ema-pullback') {
    series.fast = ema(closes, params.emaFast);
    series.slow = ema(closes, params.emaSlow);
  } else if (t === 'rompimento') {
    // extremos das N velas ANTERIORES (a atual não conta)
    const n = params.breakoutPeriod || 20;
    const hi = new Array(candles.length).fill(null);
    const lo = new Array(candles.length).fill(null);
    for (let i = n; i < candles.length; i++) {
      let h = -Infinity;
      let l = Infinity;
      for (let j = i - n; j < i; j++) {
        if (candles[j].high > h) h = candles[j].high;
        if (candles[j].low < l) l = candles[j].low;
      }
      hi[i] = h;
      lo[i] = l;
    }
    series.hi = hi;
    series.lo = lo;
  }
  return series;
}

// Avalia o sinal no fechamento do candle de índice `i`.
// params.invertSignals (para estudo): opera o contrário de cada sinal.
export function signalAt(candles, series, i, params) {
  const res = rawSignalAt(candles, series, i, params);
  if (params.invertSignals && res.signal) {
    res.signal = res.signal === 'long' ? 'short' : 'long';
    res.reason = `INVERTIDO: ${res.reason}`;
  }
  return res;
}

function rawSignalAt(candles, series, i, params) {
  const { rsi: r, atr: a } = series;
  if (i < 1 || r[i] == null || r[i - 1] == null || a[i] == null) {
    return { signal: null, reason: 'dados insuficientes para calcular os indicadores' };
  }
  const close = candles[i].close;
  const stopDistance = a[i] * params.atrStopMult;
  const base = { signal: null, crossedUp: false, crossedDown: false, stopDistance };

  switch (typeOf(params)) {
    case 'rsi-reversao': {
      const oversold = params.rsiLongMax; // zona de compra: 0..oversold
      const overbought = params.rsiShortMin; // zona de venda: overbought..100
      const snapshot = {
        close,
        rsi: r[i],
        atr: a[i],
        levels: [
          { label: 'Compra quando', value: `RSI sobe de ${oversold}` },
          { label: 'Venda quando', value: `RSI cai de ${overbought}` },
          { label: 'RSI anterior', value: r[i - 1].toFixed(1) },
        ],
      };
      if (r[i - 1] < oversold && r[i] >= oversold) {
        return { ...base, signal: 'long', snapshot, reason: `RSI saiu do sobrevendido (${r[i - 1].toFixed(1)} → ${r[i].toFixed(1)}): virada pra cima` };
      }
      if (r[i - 1] > overbought && r[i] <= overbought) {
        return { ...base, signal: 'short', snapshot, reason: `RSI saiu do sobrecomprado (${r[i - 1].toFixed(1)} → ${r[i].toFixed(1)}): virada pra baixo` };
      }
      let reason = 'RSI em zona neutra — esperando um exagero pra reverter';
      if (r[i] < oversold) reason = `sobrevendido (RSI ${r[i].toFixed(1)}) — esperando a virada pra cima`;
      else if (r[i] > overbought) reason = `sobrecomprado (RSI ${r[i].toFixed(1)}) — esperando a virada pra baixo`;
      return { ...base, snapshot, reason };
    }

    case 'rompimento': {
      const hi = series.hi[i];
      const lo = series.lo[i];
      const n = params.breakoutPeriod || 20;
      if (hi == null || lo == null) return { signal: null, reason: 'dados insuficientes para calcular os indicadores' };
      const snapshot = {
        close,
        rsi: r[i],
        atr: a[i],
        levels: [
          { label: `Rompe acima (${n} velas)`, value: hi, cls: 'gain' },
          { label: `Rompe abaixo (${n} velas)`, value: lo, cls: 'loss' },
          { label: 'Distância', value: `${Math.min(((hi - close) / close) * 100, ((close - lo) / close) * 100).toFixed(2)}%` },
        ],
      };
      if (close > hi) {
        return { ...base, signal: 'long', snapshot, reason: `preço rompeu a máxima das últimas ${n} velas (${hi})` };
      }
      if (close < lo) {
        return { ...base, signal: 'short', snapshot, reason: `preço rompeu a mínima das últimas ${n} velas (${lo})` };
      }
      return { ...base, snapshot, reason: `dentro do canal (${lo} — ${hi}), esperando rompimento` };
    }

    case 'ema-pullback': {
      // Surf de tendência: com a tendência já estabelecida (EMAs separadas),
      // espera o preço RESPIRAR até a média rápida e reagir — entra a favor.
      const { fast, slow } = series;
      if (fast[i - 1] == null || slow[i - 1] == null || fast[i] == null || slow[i] == null) {
        return { signal: null, reason: 'dados insuficientes para calcular os indicadores' };
      }
      const crossedUp = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
      const crossedDown = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
      const c = candles[i];
      const altista = fast[i] > slow[i];
      const dist = ((fast[i] - slow[i]) / close) * 100;
      const snapshot = {
        close,
        rsi: r[i],
        atr: a[i],
        emaFast: fast[i],
        emaSlow: slow[i],
        trend: altista ? 'alta' : 'baixa',
        levels: [
          { label: `EMA ${params.emaFast} (a onda)`, value: fast[i] },
          { label: `EMA ${params.emaSlow}`, value: slow[i] },
          { label: 'Força da tendência', value: `${dist >= 0 ? '+' : ''}${dist.toFixed(2)}%`, cls: dist >= 0 ? 'gain' : 'loss' },
        ],
      };
      const out = { ...base, crossedUp, crossedDown, snapshot };
      const tocouEReagiuAlta = altista && c.low <= fast[i] && c.close > fast[i];
      const tocouEReagiuBaixa = !altista && c.high >= fast[i] && c.close < fast[i];
      if (tocouEReagiuAlta && r[i] >= params.rsiLongMin && r[i] <= params.rsiLongMax) {
        return { ...out, signal: 'long', reason: `surf: tendência de alta, preço respirou até a EMA${params.emaFast} e reagiu (RSI ${r[i].toFixed(1)})` };
      }
      if (tocouEReagiuBaixa && r[i] >= params.rsiShortMin && r[i] <= params.rsiShortMax) {
        return { ...out, signal: 'short', reason: `surf: tendência de baixa, preço subiu até a EMA${params.emaFast} e reagiu (RSI ${r[i].toFixed(1)})` };
      }
      let reason = altista
        ? 'tendência de alta — esperando o preço respirar até a média pra surfar'
        : 'tendência de baixa — esperando o preço subir até a média pra surfar';
      if (tocouEReagiuAlta || tocouEReagiuBaixa) reason = `toque na média descartado: RSI ${r[i].toFixed(1)} fora da faixa`;
      return { ...out, reason };
    }

    default: {
      const { fast, slow } = series;
      if (fast[i - 1] == null || slow[i - 1] == null || fast[i] == null || slow[i] == null) {
        return { signal: null, reason: 'dados insuficientes para calcular os indicadores' };
      }
      const crossedUp = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
      const crossedDown = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
      const dist = ((fast[i] - slow[i]) / close) * 100;
      const snapshot = {
        close,
        rsi: r[i],
        atr: a[i],
        emaFast: fast[i],
        emaSlow: slow[i],
        trend: fast[i] > slow[i] ? 'alta' : 'baixa',
        levels: [
          { label: `EMA ${params.emaFast}`, value: fast[i] },
          { label: `EMA ${params.emaSlow}`, value: slow[i] },
          { label: 'Dist. cruzamento', value: `${dist >= 0 ? '+' : ''}${dist.toFixed(2)}%`, cls: dist >= 0 ? 'gain' : 'loss' },
        ],
      };
      const out = { ...base, crossedUp, crossedDown, snapshot };
      if (crossedUp && r[i] >= params.rsiLongMin && r[i] <= params.rsiLongMax) {
        return { ...out, signal: 'long', reason: `EMA${params.emaFast} cruzou acima da EMA${params.emaSlow} com RSI ${r[i].toFixed(1)}` };
      }
      if (crossedDown && r[i] >= params.rsiShortMin && r[i] <= params.rsiShortMax) {
        return { ...out, signal: 'short', reason: `EMA${params.emaFast} cruzou abaixo da EMA${params.emaSlow} com RSI ${r[i].toFixed(1)}` };
      }
      let reason = `tendência de ${snapshot.trend}, sem cruzamento`;
      if (crossedUp) reason = `cruzamento de alta descartado: RSI ${r[i].toFixed(1)} fora da faixa [${params.rsiLongMin}, ${params.rsiLongMax}]`;
      if (crossedDown) reason = `cruzamento de baixa descartado: RSI ${r[i].toFixed(1)} fora da faixa [${params.rsiShortMin}, ${params.rsiShortMax}]`;
      return { ...out, reason };
    }
  }
}

// Atalho para o robô ao vivo: avalia o último candle FECHADO da série.
export function analyze(candles, params) {
  if (candles.length < candlesNeeded(params)) {
    return { signal: null, reason: 'dados insuficientes para calcular os indicadores' };
  }
  const series = computeSeries(candles, params);
  return signalAt(candles, series, candles.length - 1, params);
}
