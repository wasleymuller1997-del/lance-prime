import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { roundTick } from './risk.js';

const DATA_DIR = path.join(ROOT, 'data');
const TRADES_FILE = path.join(DATA_DIR, 'trades-testnet.csv');

// Corretora real na TESTNET: envia ordens de verdade para a conta demo.
// O stop e o alvo ficam registrados NA CORRETORA (STOP_MARKET / TAKE_PROFIT_MARKET
// com closePosition), então a posição está protegida mesmo se o robô cair.
export class TestnetBroker {
  constructor({ client, config, filters, logger }) {
    this.client = client;
    this.config = config;
    this.filters = filters;
    this.logger = logger;
    this.positions = {}; // acompanhamento local do que está aberto
  }

  async init() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(TRADES_FILE)) {
      fs.writeFileSync(TRADES_FILE, 'data,simbolo,lado,quantidade,entrada,evento,pnl_realizado\n');
    }

    await this.client.ensureOneWayMode();
    for (const symbol of this.config.symbols) {
      await this.client.setMarginType(symbol, this.config.marginType);
      await this.client.setLeverage(symbol, this.config.leverage);
    }

    // Reconhece posições que já existiam (ex.: robô reiniciado com posição aberta).
    const risks = await this.client.positionRisk();
    for (const r of risks) {
      const amt = +r.positionAmt;
      if (amt !== 0 && this.config.symbols.includes(r.symbol)) {
        this.positions[r.symbol] = {
          side: amt > 0 ? 'long' : 'short',
          qty: Math.abs(amt),
          entryPrice: +r.entryPrice,
          openedAt: Date.now(),
        };
        this.logger.warn(`[${r.symbol}] posição já aberta na corretora reconhecida: ${this.positions[r.symbol].side} qty=${Math.abs(amt)} @ ${r.entryPrice}`);
      }
    }
    const bal = await this.balanceForRisk();
    this.logger.info(`Conectado à testnet. Saldo USDT: ${bal.toFixed(2)}`);
  }

  rolloverDay() {
    // Trava diária no modo testnet: baseada no saldo no primeiro tick do dia.
    const today = new Date().toISOString().slice(0, 10);
    if (this.day !== today) {
      this.day = today;
      this.dayStartBalance = null; // preenchido no próximo balanceForRisk()
    }
  }

  isCircuitBroken() {
    if (this.dayStartBalance == null || this.lastBalance == null) return false;
    return this.lastBalance <= this.dayStartBalance * (1 - this.config.maxDailyLossPct / 100);
  }

  async balanceForRisk() {
    const balances = await this.client.balances();
    const usdt = balances.find((b) => b.asset === 'USDT');
    const value = usdt ? +usdt.balance : 0;
    this.lastBalance = value;
    if (this.dayStartBalance == null) this.dayStartBalance = value;
    return value;
  }

  hasPosition(symbol) {
    return Boolean(this.positions[symbol]);
  }

  getPosition(symbol) {
    return this.positions[symbol] || null;
  }

  openPositionsCount() {
    return Object.keys(this.positions).length;
  }

  #fmtQty(symbol, qty) {
    return qty.toFixed(this.filters[symbol].quantityPrecision);
  }

  async open({ symbol, side, qty, sl, tp, reason }) {
    const orderSide = side === 'long' ? 'BUY' : 'SELL';
    const closeSide = side === 'long' ? 'SELL' : 'BUY';
    const f = this.filters[symbol];

    const order = await this.client.marketOrder(symbol, orderSide, this.#fmtQty(symbol, qty));
    const entryPrice = +order.avgPrice || +order.price;
    const executedQty = +order.executedQty || qty;
    this.logger.trade(`[${symbol}] ABERTURA ${side.toUpperCase()} qty=${executedQty} @ ~${entryPrice} (ordem ${order.orderId}) | motivo: ${reason}`);

    try {
      await this.client.stopMarketClose(symbol, closeSide, roundTick(sl, f.tickSize));
      await this.client.takeProfitMarketClose(symbol, closeSide, roundTick(tp, f.tickSize));
      this.logger.trade(`[${symbol}] proteções registradas na corretora: stop=${roundTick(sl, f.tickSize)} alvo=${roundTick(tp, f.tickSize)}`);
    } catch (err) {
      // Sem proteção não se fica posicionado: fecha imediatamente.
      this.logger.error(`[${symbol}] falha ao registrar stop/alvo (${err.message}) — fechando a posição por segurança`);
      await this.client.marketOrder(symbol, closeSide, this.#fmtQty(symbol, executedQty), { reduceOnly: true });
      await this.client.cancelAllOrders(symbol).catch(() => {});
      return null;
    }

    this.positions[symbol] = { side, qty: executedQty, entryPrice, sl, tp, openedAt: Date.now(), reason };
    fs.appendFileSync(TRADES_FILE, `${new Date().toISOString()},${symbol},${side},${executedQty},${entryPrice},abertura,\n`);
    return this.positions[symbol];
  }

  // A cada ciclo: verifica se a corretora fechou a posição (stop/alvo executado).
  async onCandle(symbol) {
    const pos = this.positions[symbol];
    if (!pos) return null;

    const risks = await this.client.positionRisk(symbol);
    const r = risks.find((x) => x.symbol === symbol);
    if (r && +r.positionAmt !== 0) return null; // segue aberta

    // Fechou na corretora: limpa a ordem de proteção que sobrou e apura o resultado.
    await this.client.cancelAllOrders(symbol).catch(() => {});
    let pnl = null;
    try {
      const income = await this.client.income({
        symbol,
        incomeType: 'REALIZED_PNL',
        startTime: pos.openedAt,
        limit: 20,
      });
      pnl = income.reduce((sum, i) => sum + Number(i.income), 0);
    } catch {
      // se a consulta falhar, segue sem o valor
    }
    delete this.positions[symbol];
    const pnlTxt = pnl == null ? 'PnL indisponível' : `PnL realizado ${pnl.toFixed(2)} USDT`;
    this.logger.trade(`[${symbol}] FECHAMENTO detectado na corretora (stop ou alvo executado) | ${pnlTxt}`);
    fs.appendFileSync(TRADES_FILE, `${new Date().toISOString()},${symbol},${pos.side},${pos.qty},${pos.entryPrice},fechamento,${pnl == null ? '' : pnl.toFixed(4)}\n`);
    return { symbol, side: pos.side, netPnl: pnl, motivo: 'stop/alvo na corretora' };
  }

  async close(symbol, _exitPrice, motivo) {
    const pos = this.positions[symbol];
    if (!pos) return null;
    const closeSide = pos.side === 'long' ? 'SELL' : 'BUY';
    await this.client.marketOrder(symbol, closeSide, this.#fmtQty(symbol, pos.qty), { reduceOnly: true });
    await this.client.cancelAllOrders(symbol).catch(() => {});
    delete this.positions[symbol];
    this.logger.trade(`[${symbol}] FECHAMENTO a mercado (${motivo})`);
    fs.appendFileSync(TRADES_FILE, `${new Date().toISOString()},${symbol},${pos.side},${pos.qty},${pos.entryPrice},fechamento-manual,\n`);
    return { symbol, side: pos.side, motivo };
  }
}
