import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TRADES_FILE = path.join(DATA_DIR, 'trades.csv');

// Corretora simulada: mantém saldo, posições e histórico em data/state.json.
// Usa preços reais do mercado, mas nenhuma ordem sai da sua máquina.
export class PaperBroker {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.feeRate = config.takerFeePct / 100;
  }

  async init() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.state = this.#loadState();
    if (!fs.existsSync(TRADES_FILE)) {
      fs.writeFileSync(TRADES_FILE, 'data,simbolo,lado,quantidade,entrada,saida,motivo,pnl_liquido,saldo\n');
    }
  }

  #freshState() {
    return {
      balance: this.config.paperStartBalance,
      positions: {},
      closedTrades: 0,
      day: null,
      dayStartBalance: this.config.paperStartBalance,
    };
  }

  #loadState() {
    if (!fs.existsSync(STATE_FILE)) {
      const state = this.#freshState();
      this.logger.info(`Conta simulada criada com ${state.balance.toFixed(2)} USDT`);
      this.state = state;
      this.#save();
      return state;
    }
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (typeof state.balance !== 'number' || !Number.isFinite(state.balance) || typeof state.positions !== 'object' || state.positions === null) {
        throw new Error('formato inesperado');
      }
      if (!Number.isInteger(state.closedTrades)) state.closedTrades = 0;
      if (typeof state.dayStartBalance !== 'number' || !Number.isFinite(state.dayStartBalance)) state.dayStartBalance = state.balance;
      this.logger.info(`Estado carregado: saldo ${state.balance.toFixed(2)} USDT, ${Object.keys(state.positions).length} posição(ões) aberta(s)`);
      return state;
    } catch (err) {
      // guarda o arquivo problemático em vez de apagar o histórico em silêncio
      const backup = `${STATE_FILE}.corrompido-${Date.now()}`;
      try {
        fs.renameSync(STATE_FILE, backup);
      } catch {
        /* segue com conta nova mesmo sem backup */
      }
      this.logger.error(`data/state.json inválido (${err.message}) — arquivo guardado como ${path.basename(backup)}, começando conta nova`);
      return this.#freshState();
    }
  }

  #save() {
    // escreve em arquivo temporário e troca: nunca deixa um JSON pela metade
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  }

  // Vira o dia (UTC) e fixa a base da trava de perda diária.
  rolloverDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.day !== today) {
      this.state.day = today;
      this.state.dayStartBalance = this.state.balance;
      this.#save();
    }
  }

  isCircuitBroken() {
    const limit = this.state.dayStartBalance * (1 - this.config.maxDailyLossPct / 100);
    return this.state.balance <= limit;
  }

  async balanceForRisk() {
    return this.state.balance;
  }

  availableMargin() {
    return this.state.balance - this.#usedMargin();
  }

  hasPosition(symbol) {
    return Boolean(this.state.positions[symbol]);
  }

  getPosition(symbol) {
    return this.state.positions[symbol] || null;
  }

  openPositionsCount() {
    return Object.keys(this.state.positions).length;
  }

  #usedMargin() {
    return Object.values(this.state.positions).reduce((sum, p) => sum + p.margin, 0);
  }

  async open({ symbol, side, qty, price, sl, tp, reason, candleOpenTime }) {
    const notional = qty * price;
    const margin = notional / this.config.leverage;
    const fee = notional * this.feeRate;
    const available = this.availableMargin();
    if (margin + fee > available) {
      this.logger.warn(`[${symbol}] entrada abortada: margem necessária ${margin.toFixed(2)} USDT maior que o disponível ${available.toFixed(2)} USDT`);
      return null;
    }
    this.state.balance -= fee;
    this.state.positions[symbol] = {
      side,
      qty,
      entryPrice: price,
      sl,
      tp,
      margin,
      entryFee: fee,
      openedAt: new Date().toISOString(),
      reason,
      // controle de simulação: no candle de entrada, só o preço DEPOIS da
      // entrada conta para stop/alvo (evita stop falso com pavio pré-entrada)
      entryCandleOpenTime: candleOpenTime ?? null,
      lastCheckedOpen: candleOpenTime ?? null,
      postHigh: price,
      postLow: price,
    };
    this.#save();
    this.logger.trade(`[${symbol}] ABERTURA ${side.toUpperCase()} qty=${qty} @ ${price} | stop=${sl} alvo=${tp} | motivo: ${reason}`);
    return this.state.positions[symbol];
  }

  // Verifica stop/alvo cobrindo os candles FECHADOS desde a última checagem
  // (pega buracos por reinício/queda do robô) e depois o candle em formação.
  // No candle de entrada usa só os extremos pós-entrada, acumulados poll a poll.
  async onCandle(symbol, forming, closedCandles = []) {
    const pos = this.state.positions[symbol];
    if (!pos) return null;

    if (pos.lastCheckedOpen == null) {
      // posição de versão antiga do estado: passa a acompanhar a partir de agora
      pos.lastCheckedOpen = forming.openTime;
      pos.postHigh = pos.postHigh ?? pos.entryPrice;
      pos.postLow = pos.postLow ?? pos.entryPrice;
    }

    const pending = closedCandles.filter((c) => c.openTime > pos.lastCheckedOpen);
    pending.push(forming);

    for (const candle of pending) {
      let range;
      if (candle.openTime === pos.entryCandleOpenTime) {
        pos.postHigh = Math.max(pos.postHigh, candle.close);
        pos.postLow = Math.min(pos.postLow, candle.close);
        range = { high: pos.postHigh, low: pos.postLow, open: pos.entryPrice };
      } else {
        range = candle;
      }
      pos.lastCheckedOpen = candle.openTime;
      const exit = this.#checkExit(pos, range);
      if (exit) return this.close(symbol, exit.price, exit.motivo);
    }
    this.#save();
    return null;
  }

  // Convenções: se o candle tocou stop e alvo, o stop vence (pessimista);
  // se o candle ABRIU além do stop (gap), a saída é no preço do gap, não no stop.
  #checkExit(pos, range) {
    if (pos.side === 'long') {
      if (range.low <= pos.sl) return { price: Math.min(pos.sl, range.open), motivo: 'stop' };
      if (range.high >= pos.tp) return { price: pos.tp, motivo: 'alvo' };
    } else {
      if (range.high >= pos.sl) return { price: Math.max(pos.sl, range.open), motivo: 'stop' };
      if (range.low <= pos.tp) return { price: pos.tp, motivo: 'alvo' };
    }
    return null;
  }

  async close(symbol, exitPrice, motivo) {
    const pos = this.state.positions[symbol];
    if (!pos) return null;
    const gross = pos.side === 'long'
      ? (exitPrice - pos.entryPrice) * pos.qty
      : (pos.entryPrice - exitPrice) * pos.qty;
    const exitFee = exitPrice * pos.qty * this.feeRate;
    this.state.balance += gross - exitFee;
    const netPnl = gross - exitFee - pos.entryFee;
    delete this.state.positions[symbol];
    this.state.closedTrades += 1;
    this.#save();

    const rotulo = netPnl >= 0 ? 'LUCRO' : 'PREJUÍZO';
    this.logger.trade(`[${symbol}] FECHAMENTO (${motivo}) ${pos.side.toUpperCase()} qty=${pos.qty} | entrada ${pos.entryPrice} → saída ${exitPrice} | ${rotulo} ${netPnl.toFixed(2)} USDT | saldo ${this.state.balance.toFixed(2)} USDT`);
    fs.appendFileSync(
      TRADES_FILE,
      `${new Date().toISOString()},${symbol},${pos.side},${pos.qty},${pos.entryPrice},${exitPrice},${motivo},${netPnl.toFixed(4)},${this.state.balance.toFixed(2)}\n`
    );
    return { symbol, side: pos.side, netPnl, exitPrice, motivo };
  }
}
