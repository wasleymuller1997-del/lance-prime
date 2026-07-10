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
    if (fs.existsSync(STATE_FILE)) {
      this.state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      this.logger.info(`Estado carregado: saldo ${this.state.balance.toFixed(2)} USDT, ${Object.keys(this.state.positions).length} posição(ões) aberta(s)`);
    } else {
      this.state = {
        balance: this.config.paperStartBalance,
        positions: {},
        closedTrades: 0,
        day: null,
        dayStartBalance: this.config.paperStartBalance,
      };
      this.#save();
      this.logger.info(`Conta simulada criada com ${this.state.balance.toFixed(2)} USDT`);
    }
    if (!fs.existsSync(TRADES_FILE)) {
      fs.writeFileSync(TRADES_FILE, 'data,simbolo,lado,quantidade,entrada,saida,motivo,pnl_liquido,saldo\n');
    }
  }

  #save() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  // Vira o dia (UTC) e aplica a trava de perda diária.
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

  async open({ symbol, side, qty, price, sl, tp, reason }) {
    const notional = qty * price;
    const margin = notional / this.config.leverage;
    const fee = notional * this.feeRate;
    const available = this.state.balance - this.#usedMargin();
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
    };
    this.#save();
    this.logger.trade(`[${symbol}] ABERTURA ${side.toUpperCase()} qty=${qty} @ ${price} | stop=${sl} alvo=${tp} | motivo: ${reason}`);
    return this.state.positions[symbol];
  }

  // Recebe o candle em formação e verifica stop/alvo com a máxima/mínima dele.
  // Retorna o trade fechado, ou null se a posição segue aberta.
  async onCandle(symbol, candle) {
    const pos = this.state.positions[symbol];
    if (!pos) return null;

    let exitPrice = null;
    let motivo = null;
    if (pos.side === 'long') {
      // pessimista: se o candle tocou o stop e o alvo, assume que o stop veio primeiro
      if (candle.low <= pos.sl) [exitPrice, motivo] = [pos.sl, 'stop'];
      else if (candle.high >= pos.tp) [exitPrice, motivo] = [pos.tp, 'alvo'];
    } else {
      if (candle.high >= pos.sl) [exitPrice, motivo] = [pos.sl, 'stop'];
      else if (candle.low <= pos.tp) [exitPrice, motivo] = [pos.tp, 'alvo'];
    }
    if (exitPrice == null) return null;
    return this.close(symbol, exitPrice, motivo);
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

    const emoji = netPnl >= 0 ? 'LUCRO' : 'PREJUÍZO';
    this.logger.trade(`[${symbol}] FECHAMENTO (${motivo}) ${pos.side.toUpperCase()} qty=${pos.qty} | entrada ${pos.entryPrice} → saída ${exitPrice} | ${emoji} ${netPnl.toFixed(2)} USDT | saldo ${this.state.balance.toFixed(2)} USDT`);
    fs.appendFileSync(
      TRADES_FILE,
      `${new Date().toISOString()},${symbol},${pos.side},${pos.qty},${pos.entryPrice},${exitPrice},${motivo},${netPnl.toFixed(4)},${this.state.balance.toFixed(2)}\n`
    );
    return { symbol, side: pos.side, netPnl, exitPrice, motivo };
  }
}
