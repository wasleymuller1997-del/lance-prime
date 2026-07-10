import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const DATA_DIR = path.join(ROOT, 'data');

// Corretora simulada: mantém saldo, posições e histórico em data/state.json.
// Usa preços reais do mercado, mas nenhuma ordem sai da sua máquina.
// `id` separa os arquivos quando várias instâncias rodam juntas (multi-robô).
export class PaperBroker {
  constructor({ config, logger, id = null, storage = null }) {
    this.config = config;
    this.logger = logger;
    this.feeRate = config.takerFeePct / 100;
    this.makerFeeRate = (config.makerFeePct ?? 0.02) / 100;
    // saída no alvo é ordem limitada (maker) quando o modo maker está ligado
    this.alvoFeeRate = config.entryMode === 'maker' ? this.makerFeeRate : this.feeRate;
    this.storage = storage; // banco de dados do site: sobrevive a deploys
    this.kvKey = `paper:${id || 'principal'}`;
    const suffix = id ? `-${id}` : '';
    this.stateFile = path.join(DATA_DIR, `state${suffix}.json`);
    this.tradesFile = path.join(DATA_DIR, `trades${suffix}.csv`);
  }

  async init() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.state = null;
    if (this.storage) {
      try {
        const saved = await this.storage.load(this.kvKey);
        if (saved) {
          this.state = this.#validateState(saved);
          this.logger.info(`Estado restaurado do banco: saldo ${this.state.balance.toFixed(2)} USDT, ${Object.keys(this.state.positions).length} posição(ões)`);
        }
      } catch (err) {
        this.logger.warn(`banco indisponível ao carregar (${err.message}) — tentando o arquivo local`);
      }
    }
    if (!this.state) this.state = this.#loadStateFromFile();
    if (!fs.existsSync(this.tradesFile)) {
      fs.writeFileSync(this.tradesFile, 'data,simbolo,lado,quantidade,entrada,saida,motivo,pnl_liquido,saldo\n');
    }
  }

  #freshState() {
    return {
      balance: this.config.paperStartBalance,
      positions: {},
      pending: {},
      tradeLog: [],
      closedTrades: 0,
      day: null,
      dayStartBalance: this.config.paperStartBalance,
    };
  }

  #validateState(state) {
    if (typeof state.balance !== 'number' || !Number.isFinite(state.balance) || typeof state.positions !== 'object' || state.positions === null) {
      throw new Error('formato inesperado');
    }
    if (!Number.isInteger(state.closedTrades)) state.closedTrades = 0;
    if (typeof state.dayStartBalance !== 'number' || !Number.isFinite(state.dayStartBalance)) state.dayStartBalance = state.balance;
    if (typeof state.pending !== 'object' || state.pending === null) state.pending = {};
    if (!Array.isArray(state.tradeLog)) state.tradeLog = [];
    return state;
  }

  #loadStateFromFile() {
    if (!fs.existsSync(this.stateFile)) {
      const state = this.#freshState();
      this.logger.info(`Conta simulada criada com ${state.balance.toFixed(2)} USDT`);
      this.state = state;
      this.#save();
      return state;
    }
    try {
      const state = this.#validateState(JSON.parse(fs.readFileSync(this.stateFile, 'utf8')));
      this.logger.info(`Estado carregado: saldo ${state.balance.toFixed(2)} USDT, ${Object.keys(state.positions).length} posição(ões) aberta(s)`);
      return state;
    } catch (err) {
      // guarda o arquivo problemático em vez de apagar o histórico em silêncio
      const backup = `${this.stateFile}.corrompido-${Date.now()}`;
      try {
        fs.renameSync(this.stateFile, backup);
      } catch {
        /* segue com conta nova mesmo sem backup */
      }
      this.logger.error(`data/state.json inválido (${err.message}) — arquivo guardado como ${path.basename(backup)}, começando conta nova`);
      return this.#freshState();
    }
  }

  #save() {
    // escreve em arquivo temporário e troca: nunca deixa um JSON pela metade
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.stateFile);
    // banco: agrupa gravações próximas numa só (o estado em memória manda)
    if (this.storage) {
      clearTimeout(this._kvTimer);
      this._kvTimer = setTimeout(() => {
        this.storage.save(this.kvKey, this.state).catch((err) => this.logger.warn(`falha ao salvar no banco: ${err.message}`));
      }, 800);
    }
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
    const pos = this.#createPosition(symbol, { side, qty, price, sl, tp, reason, entryFeeRate: this.feeRate, candleOpenTime });
    if (pos) this.logger.trade(`[${symbol}] ABERTURA ${side.toUpperCase()} qty=${qty} @ ${price} | stop=${sl} alvo=${tp} | motivo: ${reason}`);
    return pos;
  }

  // Verifica stop/alvo cobrindo os candles FECHADOS desde a última checagem
  // (pega buracos por reinício/queda do robô) e depois o candle em formação.
  // No candle de entrada usa só os extremos pós-entrada, acumulados poll a poll.
  async onCandle(symbol, forming, closedCandles = []) {
    // 0) Ordem limitada pendente: preenche se o preço ATRAVESSOU o nível
    //    (tocar não garante execução — há fila no livro) ou expira.
    const pend = this.state.pending?.[symbol];
    if (pend && !this.state.positions[symbol]) {
      const atravessou = pend.side === 'long' ? forming.low < pend.limitPrice : forming.high > pend.limitPrice;
      if (atravessou) {
        delete this.state.pending[symbol];
        const pos = this.#createPosition(symbol, {
          side: pend.side,
          qty: pend.qty,
          price: pend.limitPrice,
          sl: pend.sl,
          tp: pend.tp,
          riskPerUnit: pend.riskPerUnit,
          reason: pend.reason,
          entryFeeRate: this.makerFeeRate,
          candleOpenTime: forming.openTime,
        });
        if (pos) this.logger.trade(`[${symbol}] ORDEM LIMITADA PREENCHIDA ${pend.side.toUpperCase()} qty=${pend.qty} @ ${pend.limitPrice} (taxa maker)`);
        else this.#save();
      } else if (Date.now() > pend.expiresAt) {
        delete this.state.pending[symbol];
        this.#save();
        this.logger.info(`[${symbol}] ordem limitada expirou sem preencher — entrada perdida (preço não voltou até ${pend.limitPrice})`);
      }
    }

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

  hasPendingEntry(symbol) {
    return Boolean(this.state.pending?.[symbol]);
  }

  getPendingEntry(symbol) {
    return this.state.pending?.[symbol] || null;
  }

  // Modo maker: coloca a "ordem limitada" no livro simulado; preenche quando
  // o preço atravessar o nível (verificado em onCandle) ou expira.
  async placeLimitEntry({ symbol, side, qty, limitPrice, sl, tp, stopDistance, reason, expiresAt }) {
    this.state.pending ??= {};
    this.state.pending[symbol] = {
      side,
      qty,
      limitPrice,
      sl,
      tp,
      riskPerUnit: stopDistance,
      reason,
      placedAt: Date.now(),
      expiresAt,
    };
    this.#save();
    this.logger.trade(`[${symbol}] ORDEM LIMITADA ${side.toUpperCase()} qty=${qty} @ ${limitPrice} (stop=${sl} alvo=${tp}) — aguardando preenchimento`);
    return this.state.pending[symbol];
  }

  // Cria a posição debitando margem e taxa de entrada (modo taker ou maker).
  #createPosition(symbol, { side, qty, price, sl, tp, riskPerUnit, reason, entryFeeRate, candleOpenTime }) {
    const notional = qty * price;
    const margin = notional / this.config.leverage;
    const fee = notional * entryFeeRate;
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
      riskPerUnit: riskPerUnit ?? Math.abs(price - sl),
      margin,
      entryFee: fee,
      openedAt: new Date().toISOString(),
      reason,
      entryCandleOpenTime: candleOpenTime ?? null,
      lastCheckedOpen: candleOpenTime ?? null,
      postHigh: price,
      postLow: price,
    };
    this.#save();
    return this.state.positions[symbol];
  }

  // Move o stop (breakeven/trailing) — a checagem de que só aperta é do chamador.
  async updateStop(symbol, newSl) {
    const pos = this.state.positions[symbol];
    if (!pos) return false;
    pos.sl = newSl;
    this.#save();
    return true;
  }

  async close(symbol, exitPrice, motivo) {
    const pos = this.state.positions[symbol];
    if (!pos) return null;
    const gross = pos.side === 'long'
      ? (exitPrice - pos.entryPrice) * pos.qty
      : (pos.entryPrice - exitPrice) * pos.qty;
    const exitFee = exitPrice * pos.qty * (motivo === 'alvo' ? this.alvoFeeRate : this.feeRate);
    this.state.balance += gross - exitFee;
    const netPnl = gross - exitFee - pos.entryFee;
    delete this.state.positions[symbol];
    this.state.closedTrades += 1;

    // histórico das operações persistido junto com o estado (sobrevive a deploy)
    this.state.tradeLog ??= [];
    this.state.tradeLog.unshift({
      data: new Date().toISOString(),
      simbolo: symbol,
      lado: pos.side,
      quantidade: pos.qty,
      entrada: pos.entryPrice,
      saida: exitPrice,
      motivo,
      pnl_liquido: Number(netPnl.toFixed(4)),
      saldo: Number(this.state.balance.toFixed(2)),
    });
    if (this.state.tradeLog.length > 200) this.state.tradeLog.length = 200;
    this.#save();

    const rotulo = netPnl >= 0 ? 'LUCRO' : 'PREJUÍZO';
    this.logger.trade(`[${symbol}] FECHAMENTO (${motivo}) ${pos.side.toUpperCase()} qty=${pos.qty} | entrada ${pos.entryPrice} → saída ${exitPrice} | ${rotulo} ${netPnl.toFixed(2)} USDT | saldo ${this.state.balance.toFixed(2)} USDT`);
    fs.appendFileSync(
      this.tradesFile,
      `${new Date().toISOString()},${symbol},${pos.side},${pos.qty},${pos.entryPrice},${exitPrice},${motivo},${netPnl.toFixed(4)},${this.state.balance.toFixed(2)}\n`
    );
    return { symbol, side: pos.side, netPnl, exitPrice, motivo };
  }
}
