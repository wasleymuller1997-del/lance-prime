// Dimensionamento de posição e arredondamentos exigidos pelos filtros da corretora.

function decimalsOf(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

// Arredonda PRA BAIXO para o múltiplo de `step` (LOT_SIZE.stepSize).
export function roundStep(value, step) {
  if (!step) return value;
  const floored = Math.floor(value / step + 1e-9) * step;
  return Number(floored.toFixed(decimalsOf(step)));
}

// Arredonda para o múltiplo de `tick` mais próximo (PRICE_FILTER.tickSize).
export function roundTick(price, tick) {
  if (!tick) return price;
  return Number((Math.round(price / tick) * tick).toFixed(decimalsOf(tick)));
}

// Calcula a quantidade da ordem de forma que, se o stop for atingido,
// a perda TOTAL (movimento + taxas de entrada e saída) seja ~riskPct% da banca,
// limitada pela margem livre disponível.
export function computeQty({ balance, availableMargin, price, stopDistance, riskPct, leverage, filters, feeRate = 0, maxMarginPct = 90 }) {
  if (!(stopDistance > 0)) return { qty: 0, reason: 'distância do stop inválida' };
  if (!(balance > 0)) return { qty: 0, reason: 'saldo indisponível' };

  const riskAmount = balance * (riskPct / 100);
  // custo por unidade se o stop bater: movimento até o stop + taxa ida e volta
  const costPerUnit = stopDistance + feeRate * 2 * price;
  let qty = riskAmount / costPerUnit;

  // Nunca usar mais que maxMarginPct% da margem LIVRE (não da banca total,
  // que pode já estar parcialmente reservada por outras posições).
  const marginBase = availableMargin == null ? balance : Math.min(balance, availableMargin);
  if (!(marginBase > 0)) return { qty: 0, reason: 'sem margem livre disponível' };
  const maxNotional = marginBase * (maxMarginPct / 100) * leverage;
  if (qty * price > maxNotional) qty = maxNotional / price;

  qty = roundStep(qty, filters.stepSize);

  if (qty < filters.minQty || qty <= 0) {
    return { qty: 0, reason: `quantidade ${qty} abaixo do mínimo do símbolo (${filters.minQty})` };
  }
  if (filters.minNotional && qty * price < filters.minNotional) {
    return { qty: 0, reason: `valor da ordem (${(qty * price).toFixed(2)} USDT) abaixo do mínimo do símbolo (${filters.minNotional} USDT) — banca ou risco por trade pequenos demais` };
  }
  return { qty };
}

// Stop e alvo a partir do preço de entrada, já ajustados ao tick do símbolo.
export function stopAndTarget({ side, entryPrice, stopDistance, riskReward, filters }) {
  const sl = side === 'long' ? entryPrice - stopDistance : entryPrice + stopDistance;
  const tp = side === 'long' ? entryPrice + stopDistance * riskReward : entryPrice - stopDistance * riskReward;
  return { sl: roundTick(sl, filters.tickSize), tp: roundTick(tp, filters.tickSize) };
}
