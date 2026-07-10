import crypto from 'node:crypto';

const BASES = {
  testnet: 'https://testnet.binancefuture.com',
  mainnet: 'https://fapi.binance.com',
};

// Cliente REST mínimo para a API de futuros USD-M da Binance.
// Docs: https://developers.binance.com/docs/derivatives/usds-margined-futures
export class BinanceFutures {
  constructor({ apiKey, apiSecret, network = 'testnet' } = {}) {
    this.apiKey = apiKey || '';
    this.apiSecret = apiSecret || '';
    this.base = BASES[network];
    if (!this.base) throw new Error(`rede desconhecida: ${network}`);
  }

  async #request(method, path, params = {}, signed = false) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    if (signed) {
      if (!this.apiKey || !this.apiSecret) {
        throw new Error('BINANCE_API_KEY/BINANCE_API_SECRET não configurados — necessários no modo testnet (veja o .env.example)');
      }
      qs.set('timestamp', String(Date.now()));
      qs.set('recvWindow', '10000');
      qs.set('signature', crypto.createHmac('sha256', this.apiSecret).update(qs.toString()).digest('hex'));
    }
    const query = qs.toString();
    const url = `${this.base}${path}${query ? `?${query}` : ''}`;
    const headers = this.apiKey ? { 'X-MBX-APIKEY': this.apiKey } : {};

    let res;
    try {
      res = await fetch(url, { method, headers });
    } catch (err) {
      throw new Error(`falha de rede em ${method} ${path}: ${err.message}`);
    }
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!res.ok) {
      const detail = body && body.msg ? `${body.code}: ${body.msg}` : String(text).slice(0, 300);
      const error = new Error(`Binance ${method} ${path} → HTTP ${res.status} (${detail})`);
      error.binanceCode = body && body.code;
      throw error;
    }
    return body;
  }

  publicGet(path, params) {
    return this.#request('GET', path, params, false);
  }

  signed(method, path, params) {
    return this.#request(method, path, params, true);
  }

  // ---------- Mercado (endpoints públicos) ----------

  async klines(symbol, interval, { limit = 200, startTime, endTime } = {}) {
    const raw = await this.publicGet('/fapi/v1/klines', { symbol, interval, limit, startTime, endTime });
    return raw.map((k) => ({
      openTime: k[0],
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume: +k[5],
      closeTime: k[6],
    }));
  }

  async price(symbol) {
    const d = await this.publicGet('/fapi/v1/ticker/price', { symbol });
    return +d.price;
  }

  exchangeInfo() {
    return this.publicGet('/fapi/v1/exchangeInfo');
  }

  // ---------- Conta e ordens (endpoints assinados) ----------

  balances() {
    return this.signed('GET', '/fapi/v2/balance');
  }

  positionRisk(symbol) {
    return this.signed('GET', '/fapi/v2/positionRisk', symbol ? { symbol } : {});
  }

  setLeverage(symbol, leverage) {
    return this.signed('POST', '/fapi/v1/leverage', { symbol, leverage });
  }

  async setMarginType(symbol, marginType) {
    try {
      return await this.signed('POST', '/fapi/v1/marginType', { symbol, marginType });
    } catch (err) {
      if (err.binanceCode === -4046) return null; // já está no modo pedido
      throw err;
    }
  }

  // Garante modo one-way (posição única por símbolo), que é o que o robô usa.
  async ensureOneWayMode() {
    try {
      await this.signed('POST', '/fapi/v1/positionSide/dual', { dualSidePosition: 'false' });
    } catch (err) {
      if (err.binanceCode === -4059) return; // já está em one-way
      throw err;
    }
  }

  marketOrder(symbol, side, quantity, { reduceOnly = false } = {}) {
    return this.signed('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'MARKET',
      quantity,
      reduceOnly: reduceOnly ? 'true' : undefined,
      newOrderRespType: 'RESULT',
    });
  }

  stopMarketClose(symbol, side, stopPrice) {
    return this.signed('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'STOP_MARKET',
      stopPrice,
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    });
  }

  takeProfitMarketClose(symbol, side, stopPrice) {
    return this.signed('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice,
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    });
  }

  cancelAllOrders(symbol) {
    return this.signed('DELETE', '/fapi/v1/allOpenOrders', { symbol });
  }

  cancelOrder(symbol, orderId) {
    return this.signed('DELETE', '/fapi/v1/order', { symbol, orderId });
  }

  income(params) {
    return this.signed('GET', '/fapi/v1/income', params);
  }
}

// Extrai os filtros de negociação de um símbolo a partir do exchangeInfo.
export function extractFilters(info, symbol) {
  const s = info.symbols.find((x) => x.symbol === symbol);
  if (!s) throw new Error(`símbolo ${symbol} não existe na corretora`);
  const lot = s.filters.find((f) => f.filterType === 'LOT_SIZE') || {};
  const priceF = s.filters.find((f) => f.filterType === 'PRICE_FILTER') || {};
  const notional = s.filters.find((f) => f.filterType === 'MIN_NOTIONAL') || {};
  return {
    stepSize: +(lot.stepSize || 0),
    minQty: +(lot.minQty || 0),
    tickSize: +(priceF.tickSize || 0),
    minNotional: +(notional.notional || 0),
    quantityPrecision: s.quantityPrecision,
    pricePrecision: s.pricePrecision,
  };
}
