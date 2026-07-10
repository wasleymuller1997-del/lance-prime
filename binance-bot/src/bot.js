import fs from 'node:fs';
import path from 'node:path';
import { ROOT, INTERVALS } from './config.js';
import { analyze } from './strategy.js';
import { computeQty, stopAndTarget } from './risk.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Loop principal: a cada ciclo vira o dia se preciso, reconcilia com a
// corretora, gerencia posições abertas e avalia novas entradas por símbolo.
// `id` separa o arquivo de estado quando várias instâncias rodam juntas.
export class Bot {
  constructor({ config, client, broker, logger, filters, id = null }) {
    this.config = config;
    this.client = client;
    this.broker = broker;
    this.logger = logger;
    this.filters = filters;
    this.stateFile = path.join(ROOT, 'data', `bot-state${id ? `-${id}` : ''}.json`);
    // cooldowns e sinais já consumidos sobrevivem a reinícios — sem isso um
    // restart no meio do candle reentraria no mesmo cruzamento
    const saved = this.#loadState();
    this.cooldowns = saved.cooldowns || {};
    this.handledSignals = saved.handledSignals || {};
    this.paused = Boolean(saved.paused);
    this.lastPrices = {}; // symbol → { price, at } para o painel
    this.lastAnalysis = {}; // symbol → última análise (indicadores + motivo) para o painel
    this.lastCandles = {}; // symbol → últimos fechamentos [t, close] para o mini-gráfico
    this.events = []; // diário de decisões para o painel (mais recente primeiro)
    this.lastCrossEvent = {}; // dedupe: 1 evento de cruzamento descartado por candle
    this.running = false;
  }

  // Registra uma decisão no diário do painel.
  #event(symbol, type, text) {
    this.events.unshift({ at: Date.now(), symbol, type, text });
    if (this.events.length > 50) this.events.length = 50;
  }

  #loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  #saveState() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ cooldowns: this.cooldowns, handledSignals: this.handledSignals, paused: this.paused }));
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      this.logger.warn(`não consegui salvar o estado do robô: ${err.message}`);
    }
  }

  #markCooldown(symbol) {
    this.cooldowns[symbol] = Date.now();
    this.#saveState();
  }

  async start() {
    this.running = true;
    this.logger.info(`Robô iniciado: modo ${this.config.mode.toUpperCase()} | ${this.config.symbols.join(', ')} | tempo gráfico ${this.config.interval} | alavancagem ${this.config.leverage}x | risco ${this.config.riskPerTradePct}%/trade`);
    while (this.running) {
      const startedAt = Date.now();
      await this.tick();
      const elapsed = Date.now() - startedAt;
      const wait = Math.max(1000, this.config.pollSeconds * 1000 - elapsed);
      if (this.running) await sleep(wait);
    }
    this.logger.info('Robô encerrado.');
  }

  stop() {
    this.running = false;
  }

  pause() {
    this.paused = true;
    this.#saveState();
  }

  resume() {
    this.paused = false;
    this.#saveState();
  }

  // Encerramento manual pelo painel: fecha a mercado no preço atual.
  async closeManual(symbol) {
    if (!this.broker.hasPosition(symbol)) return null;
    let price = this.lastPrices[symbol]?.price;
    try {
      price = await this.client.price(symbol);
    } catch {
      /* usa o último preço conhecido */
    }
    const result = await this.broker.close(symbol, price, 'manual (painel)');
    if (result) this.#markCooldown(symbol);
    return result;
  }

  async tick() {
    try {
      await this.broker.rolloverDay();
    } catch (err) {
      this.logger.error(`virada de dia falhou: ${err.message}`);
    }
    if (this.broker.reconcile) {
      try {
        await this.broker.reconcile();
      } catch (err) {
        this.logger.warn(`reconciliação com a corretora falhou: ${err.message}`);
      }
    }
    for (const symbol of this.config.symbols) {
      try {
        await this.#processSymbol(symbol);
      } catch (err) {
        this.logger.error(`[${symbol}] falha no ciclo: ${err.message}`);
      }
    }
  }

  async #processSymbol(symbol) {
    const candles = await this.client.klines(symbol, this.config.interval, { limit: 300 });
    if (candles.length < 2) return;
    const forming = candles[candles.length - 1]; // candle ainda aberto = preço atual
    const closed = candles.slice(0, -1);
    this.lastPrices[symbol] = { price: forming.close, at: Date.now() };

    // 1) Gestão da posição aberta: stop/alvo (paper) ou sincronização (testnet).
    const closedTrade = await this.broker.onCandle(symbol, forming, closed);
    if (closedTrade) {
      this.#markCooldown(symbol);
      const pnlTxt = closedTrade.netPnl != null ? `${closedTrade.netPnl >= 0 ? '+' : ''}${closedTrade.netPnl.toFixed(2)} USDT` : 'PnL na corretora';
      this.#event(symbol, closedTrade.netPnl != null && closedTrade.netPnl >= 0 ? 'saida-lucro' : 'saida-prejuizo', `saiu no ${closedTrade.motivo}: ${pnlTxt}`);
    }

    // 2) Análise do último candle fechado.
    const res = analyze(closed, this.config.strategy);
    const s = res.snapshot;
    const painel = s
      ? `preço ${forming.close} | EMA${this.config.strategy.emaFast} ${s.emaFast.toFixed(2)} / EMA${this.config.strategy.emaSlow} ${s.emaSlow.toFixed(2)} | RSI ${s.rsi.toFixed(1)}`
      : `preço ${forming.close}`;
    if (res.signal) this.logger.info(`[${symbol}] ${painel} | >>> SINAL ${res.signal.toUpperCase()}: ${res.reason}`);
    else this.logger.info(`[${symbol}] ${painel} | ${res.reason}`);

    this.lastAnalysis[symbol] = {
      at: Date.now(),
      price: forming.close,
      candleOpenTime: forming.openTime,
      signal: res.signal || null,
      reason: res.reason,
      snapshot: res.snapshot || null,
    };
    this.lastCandles[symbol] = closed.slice(-48).map((c) => [c.openTime, c.close]);

    // Diário: cruzamento visto mas recusado pelo filtro (1 evento por candle).
    if (!res.signal && (res.crossedUp || res.crossedDown)) {
      const candleKey = closed[closed.length - 1].openTime;
      if (this.lastCrossEvent[symbol] !== candleKey) {
        this.lastCrossEvent[symbol] = candleKey;
        this.#event(symbol, 'descartado', res.reason);
      }
    }

    // 3) Com posição aberta: fecha por tempo (time-stop) ou cruzamento contrário.
    if (this.broker.hasPosition(symbol)) {
      const pos = this.broker.getPosition(symbol);
      const maxCandles = this.config.strategy.maxCandlesInTrade;
      if (maxCandles > 0) {
        const openedMs = typeof pos.openedAt === 'string' ? Date.parse(pos.openedAt) : pos.openedAt;
        if (Date.now() - openedMs >= maxCandles * INTERVALS[this.config.interval]) {
          await this.broker.close(symbol, forming.close, `tempo máximo na operação (${maxCandles} candles)`);
          this.#markCooldown(symbol);
          return;
        }
      }
      if (this.config.closeOnOppositeSignal) {
        const contrario = (pos.side === 'long' && res.crossedDown) || (pos.side === 'short' && res.crossedUp);
        if (contrario) {
          const r = await this.broker.close(symbol, forming.close, 'cruzamento contrário');
          this.#markCooldown(symbol);
          if (r) this.#event(symbol, r.netPnl != null && r.netPnl >= 0 ? 'saida-lucro' : 'saida-prejuizo', `saiu no cruzamento contrário: ${r.netPnl != null ? `${r.netPnl >= 0 ? '+' : ''}${r.netPnl.toFixed(2)} USDT` : 'PnL na corretora'}`);
        }
      }
      return;
    }

    // 4) Sem posição: avalia entrada.
    if (!res.signal) return;

    // Cada candle de sinal é consumido UMA única vez (igual ao backtest):
    // se a entrada for bloqueada agora, o sinal não é reaproveitado minutos
    // depois no meio do candle, a um preço que o backtest nunca viu.
    const signalKey = closed[closed.length - 1].openTime;
    if (this.handledSignals[symbol] === signalKey) return;
    this.handledSignals[symbol] = signalKey;
    this.#saveState();
    this.#event(symbol, 'sinal', `sinal ${res.signal.toUpperCase()} detectado: ${res.reason}`);

    if (this.paused) {
      this.logger.info(`[${symbol}] sinal ignorado: novas entradas pausadas pelo painel`);
      this.#event(symbol, 'bloqueado', 'entrada bloqueada: robô pausado pelo painel');
      return;
    }

    // Saldo atualizado ANTES da trava diária, senão ela avalia um valor velho.
    const balance = await this.broker.balanceForRisk();
    if (this.broker.isCircuitBroken()) {
      this.logger.warn(`[${symbol}] sinal ignorado: trava de perda diária ativada (${this.config.maxDailyLossPct}% no dia) — novas entradas só amanhã`);
      this.#event(symbol, 'bloqueado', `entrada bloqueada: trava de perda diária (${this.config.maxDailyLossPct}%)`);
      return;
    }
    if (this.broker.openPositionsCount() >= this.config.maxOpenPositions) {
      this.logger.info(`[${symbol}] sinal ignorado: limite de ${this.config.maxOpenPositions} posições simultâneas atingido`);
      this.#event(symbol, 'bloqueado', `entrada bloqueada: já há ${this.config.maxOpenPositions} posições abertas`);
      return;
    }
    const last = this.cooldowns[symbol];
    if (last && Date.now() - last < this.config.cooldownMinutes * 60_000) {
      this.logger.info(`[${symbol}] sinal ignorado: aguardando ${this.config.cooldownMinutes}min de intervalo entre operações`);
      this.#event(symbol, 'bloqueado', `entrada bloqueada: intervalo de ${this.config.cooldownMinutes}min entre operações`);
      return;
    }

    const price = forming.close;
    const availableMargin = this.broker.availableMargin ? await this.broker.availableMargin() : balance;
    const sized = computeQty({
      balance,
      availableMargin,
      price,
      stopDistance: res.stopDistance,
      riskPct: this.config.riskPerTradePct,
      leverage: this.config.leverage,
      feeRate: this.config.takerFeePct / 100,
      filters: this.filters[symbol],
    });
    if (!sized.qty) {
      this.logger.warn(`[${symbol}] sinal ignorado: ${sized.reason}`);
      this.#event(symbol, 'bloqueado', `entrada bloqueada: ${sized.reason}`);
      return;
    }
    const { sl, tp } = stopAndTarget({
      side: res.signal,
      entryPrice: price,
      stopDistance: res.stopDistance,
      riskReward: this.config.strategy.riskReward,
      filters: this.filters[symbol],
    });

    const opened = await this.broker.open({
      symbol,
      side: res.signal,
      qty: sized.qty,
      price,
      sl,
      tp,
      reason: res.reason,
      candleOpenTime: forming.openTime,
    });
    if (opened) {
      this.#markCooldown(symbol);
      this.#event(symbol, 'entrada', `entrou ${res.signal.toUpperCase()} qty ${sized.qty} @ ${price} (stop ${sl} · alvo ${tp})`);
    }
  }
}
