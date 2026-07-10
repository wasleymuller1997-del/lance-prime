import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { roundTick } from './risk.js';

const DATA_DIR = path.join(ROOT, 'data');
const TRADES_FILE = path.join(DATA_DIR, 'trades-testnet.csv');
const STATE_FILE = path.join(DATA_DIR, 'testnet-state.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Corretora real na TESTNET: envia ordens de verdade para a conta demo.
// Política: NUNCA ficar posicionado sem stop/alvo registrados na corretora —
// se a proteção falhar, a posição é fechada; se nem o fechamento sair, ela
// fica registrada localmente e o robô tenta protegê-la a cada ciclo.
export class TestnetBroker {
  constructor({ client, config, filters, logger }) {
    this.client = client;
    this.config = config;
    this.filters = filters;
    this.logger = logger;
    this.positions = {}; // acompanhamento local do que está aberto
    this.day = null;
    this.dayStartBalance = null;
    this.lastBalance = null;
    this.lastAvailable = null;
  }

  async init() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(TRADES_FILE)) {
      fs.writeFileSync(TRADES_FILE, 'data,simbolo,lado,quantidade,entrada,evento,pnl_liquido\n');
    }
    this.#loadDayState();

    await this.client.ensureOneWayMode();
    for (const symbol of this.config.symbols) {
      await this.client.setMarginType(symbol, this.config.marginType);
      await this.client.setLeverage(symbol, this.config.leverage);
    }

    // Reconcilia com a corretora: limpa ordens órfãs de símbolos zerados e
    // só adota posições existentes que ainda tenham stop/alvo registrados.
    const risks = await this.client.positionRisk();
    for (const symbol of this.config.symbols) {
      const r = risks.find((x) => x.symbol === symbol);
      const amt = r ? +r.positionAmt : 0;
      if (amt === 0) {
        await this.client.cancelAllOrders(symbol).catch((err) =>
          this.logger.warn(`[${symbol}] falha ao limpar ordens antigas: ${err.message}`)
        );
        continue;
      }
      const side = amt > 0 ? 'long' : 'short';
      const qty = Math.abs(amt);
      const orders = await this.client.openOrders(symbol).catch(() => []);
      const protegida = orders.some(
        (o) => (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET') && String(o.closePosition) === 'true'
      );
      if (protegida) {
        this.positions[symbol] = { side, qty, entryPrice: +r.entryPrice, openedAt: Date.now() };
        this.logger.warn(`[${symbol}] posição já aberta na corretora adotada: ${side} qty=${qty} @ ${r.entryPrice} (stop/alvo já registrados)`);
      } else {
        this.logger.error(`[${symbol}] posição existente SEM stop/alvo na corretora — fechando por segurança`);
        await this.client.marketOrder(symbol, amt > 0 ? 'SELL' : 'BUY', this.#fmtQty(symbol, qty), { reduceOnly: true });
        await this.client.cancelAllOrders(symbol).catch(() => {});
      }
    }
    const bal = await this.balanceForRisk();
    this.logger.info(`Conectado à testnet. Saldo USDT: ${bal.toFixed(2)}`);
  }

  #loadDayState() {
    try {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const today = new Date().toISOString().slice(0, 10);
      if (saved.day === today && typeof saved.dayStartBalance === 'number' && Number.isFinite(saved.dayStartBalance)) {
        this.day = saved.day;
        this.dayStartBalance = saved.dayStartBalance;
        this.logger.info(`Trava diária restaurada: base do dia ${saved.dayStartBalance.toFixed(2)} USDT`);
      }
    } catch {
      /* sem estado salvo: será criado no primeiro ciclo */
    }
  }

  #saveDayState() {
    try {
      const tmp = `${STATE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ day: this.day, dayStartBalance: this.dayStartBalance }));
      fs.renameSync(tmp, STATE_FILE);
    } catch {
      /* segue sem persistir */
    }
  }

  async #refreshBalance() {
    const balances = await this.client.balances();
    const usdt = balances.find((b) => b.asset === 'USDT');
    this.lastBalance = usdt ? +usdt.balance : 0;
    this.lastAvailable = usdt ? +usdt.availableBalance : 0;
    if (this.dayStartBalance == null) {
      this.dayStartBalance = this.lastBalance;
      this.#saveDayState();
    }
    return this.lastBalance;
  }

  // Vira o dia (UTC) fixando a base da trava diária no saldo do primeiro ciclo.
  async rolloverDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.day === today) return;
    this.day = today;
    this.dayStartBalance = null;
    await this.#refreshBalance().catch(() => {}); // preenche dayStartBalance
    this.#saveDayState();
  }

  isCircuitBroken() {
    if (this.dayStartBalance == null || this.lastBalance == null) return false;
    return this.lastBalance <= this.dayStartBalance * (1 - this.config.maxDailyLossPct / 100);
  }

  async balanceForRisk() {
    return this.#refreshBalance();
  }

  availableMargin() {
    return this.lastAvailable ?? this.lastBalance ?? 0;
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

  async #placeProtections(symbol, side, sl, tp) {
    const closeSide = side === 'long' ? 'SELL' : 'BUY';
    const f = this.filters[symbol];
    await this.client.stopMarketClose(symbol, closeSide, roundTick(sl, f.tickSize));
    await this.client.takeProfitMarketClose(symbol, closeSide, roundTick(tp, f.tickSize));
  }

  async open({ symbol, side, qty, price, sl, tp, reason }) {
    const orderSide = side === 'long' ? 'BUY' : 'SELL';
    const closeSide = side === 'long' ? 'SELL' : 'BUY';

    const order = await this.client.marketOrder(symbol, orderSide, this.#fmtQty(symbol, qty));
    const executedQty = +order.executedQty || qty;
    let entryPrice = +order.avgPrice;
    if (!entryPrice) {
      // MARKET nunca traz "price"; o fallback correto é o valor médio executado
      entryPrice = +order.cumQuote && executedQty ? +order.cumQuote / executedQty : price;
    }
    this.logger.trade(`[${symbol}] ABERTURA ${side.toUpperCase()} qty=${executedQty} @ ~${entryPrice} (ordem ${order.orderId}) | motivo: ${reason}`);

    // Reancora stop/alvo no preço REAL de execução: slippage na entrada não
    // pode mudar o risco planejado (1% continua 1%).
    const drift = entryPrice - price;
    const slFinal = roundTick(sl + drift, this.filters[symbol].tickSize);
    const tpFinal = roundTick(tp + drift, this.filters[symbol].tickSize);

    try {
      await this.#placeProtections(symbol, side, slFinal, tpFinal);
      this.logger.trade(`[${symbol}] proteções registradas na corretora: stop=${slFinal} alvo=${tpFinal}`);
    } catch (err) {
      this.logger.error(`[${symbol}] falha ao registrar stop/alvo (${err.message}) — fechando a posição por segurança`);
      let fechada = false;
      for (let tentativa = 1; tentativa <= 3 && !fechada; tentativa++) {
        try {
          await this.client.marketOrder(symbol, closeSide, this.#fmtQty(symbol, executedQty), { reduceOnly: true });
          fechada = true;
        } catch (err2) {
          this.logger.error(`[${symbol}] tentativa ${tentativa}/3 de fechamento de emergência falhou: ${err2.message}`);
          if (tentativa < 3) await sleep(1500 * tentativa);
        }
      }
      await this.client.cancelAllOrders(symbol).catch((e) => this.logger.warn(`[${symbol}] falha ao cancelar ordens: ${e.message}`));
      if (!fechada) {
        // Nunca perder a posição de vista: registra e tenta proteger a cada ciclo.
        this.positions[symbol] = { side, qty: executedQty, entryPrice, sl: slFinal, tp: tpFinal, openedAt: Date.now(), unprotected: true, reason };
        this.logger.error(`[${symbol}] ATENÇÃO: posição aberta SEM PROTEÇÃO na corretora — o robô vai tentar proteger/fechar a cada ciclo; confira a testnet`);
        fs.appendFileSync(TRADES_FILE, `${new Date().toISOString()},${symbol},${side},${executedQty},${entryPrice},abertura-sem-protecao,\n`);
        return this.positions[symbol];
      }
      return null;
    }

    this.positions[symbol] = { side, qty: executedQty, entryPrice, sl: slFinal, tp: tpFinal, openedAt: Date.now(), reason };
    fs.appendFileSync(TRADES_FILE, `${new Date().toISOString()},${symbol},${side},${executedQty},${entryPrice},abertura,\n`);
    return this.positions[symbol];
  }

  // A cada ciclo: reprotege posição desprotegida e verifica se a corretora
  // fechou a posição (stop/alvo executado).
  async onCandle(symbol) {
    const pos = this.positions[symbol];
    if (!pos) return null;

    if (pos.unprotected) {
      try {
        await this.#placeProtections(symbol, pos.side, pos.sl, pos.tp);
        pos.unprotected = false;
        this.logger.trade(`[${symbol}] proteções registradas com sucesso após nova tentativa`);
      } catch (err) {
        if (err.binanceCode === -2021) {
          // preço já passou do stop/alvo: não dá mais para proteger, fecha já
          this.logger.error(`[${symbol}] preço já ultrapassou o stop/alvo — fechando a mercado`);
          return this.close(symbol, null, 'proteção impossível');
        }
        this.logger.error(`[${symbol}] posição segue SEM PROTEÇÃO (${err.message}) — nova tentativa no próximo ciclo`);
      }
    }

    const risks = await this.client.positionRisk(symbol);
    const r = risks.find((x) => x.symbol === symbol);
    if (r && +r.positionAmt !== 0) return null; // segue aberta

    // Fechou na corretora: limpa a ordem de proteção que sobrou e apura o resultado.
    await this.client.cancelAllOrders(symbol).catch((err) =>
      this.logger.warn(`[${symbol}] falha ao cancelar ordem de proteção remanescente: ${err.message} — nova tentativa na reconciliação`)
    );
    let pnl = null;
    try {
      // resultado + taxas + funding do período da posição (líquido de verdade);
      // margem de 60s no startTime por possível diferença de relógio
      const income = await this.client.income({ symbol, startTime: pos.openedAt - 60_000, limit: 100 });
      const rows = income.filter((i) => ['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE'].includes(i.incomeType));
      if (rows.length) pnl = rows.reduce((sum, i) => sum + Number(i.income), 0);
    } catch {
      /* segue sem o valor */
    }
    await this.#refreshBalance().catch(() => {}); // trava diária enxerga a perda já
    delete this.positions[symbol];
    const pnlTxt = pnl == null ? 'PnL indisponível (consulte a testnet)' : `PnL líquido ${pnl.toFixed(2)} USDT`;
    this.logger.trade(`[${symbol}] FECHAMENTO detectado na corretora (stop ou alvo executado) | ${pnlTxt}`);
    fs.appendFileSync(TRADES_FILE, `${new Date().toISOString()},${symbol},${pos.side},${pos.qty},${pos.entryPrice},fechamento,${pnl == null ? '' : pnl.toFixed(4)}\n`);
    return { symbol, side: pos.side, netPnl: pnl, motivo: 'stop/alvo na corretora' };
  }

  // Rede de segurança por ciclo: adota posições que existem na corretora mas
  // que o robô não está rastreando (ex.: falha no meio de uma abertura).
  async reconcile() {
    const risks = await this.client.positionRisk();
    for (const symbol of this.config.symbols) {
      if (this.positions[symbol]) continue;
      const r = risks.find((x) => x.symbol === symbol);
      if (r && +r.positionAmt !== 0) {
        const amt = +r.positionAmt;
        this.positions[symbol] = {
          side: amt > 0 ? 'long' : 'short',
          qty: Math.abs(amt),
          entryPrice: +r.entryPrice,
          openedAt: Date.now(),
          adopted: true,
        };
        this.logger.warn(`[${symbol}] posição não rastreada encontrada na corretora — adotada para monitoramento (confira stop/alvo na testnet)`);
      }
    }
  }

  async close(symbol, _exitPrice, motivo) {
    const pos = this.positions[symbol];
    if (!pos) return null;
    const closeSide = pos.side === 'long' ? 'SELL' : 'BUY';
    await this.client.marketOrder(symbol, closeSide, this.#fmtQty(symbol, pos.qty), { reduceOnly: true });
    await this.client.cancelAllOrders(symbol).catch((err) =>
      this.logger.warn(`[${symbol}] falha ao cancelar ordens após fechamento: ${err.message}`)
    );
    await this.#refreshBalance().catch(() => {});
    delete this.positions[symbol];
    this.logger.trade(`[${symbol}] FECHAMENTO a mercado (${motivo})`);
    fs.appendFileSync(TRADES_FILE, `${new Date().toISOString()},${symbol},${pos.side},${pos.qty},${pos.entryPrice},fechamento-manual,\n`);
    return { symbol, side: pos.side, motivo };
  }
}
