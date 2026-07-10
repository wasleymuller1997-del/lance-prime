import { analyze } from './strategy.js';
import { computeQty, stopAndTarget } from './risk.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Loop principal: a cada ciclo busca candles, gerencia posições abertas e
// avalia novas entradas para cada símbolo configurado.
export class Bot {
  constructor({ config, client, broker, logger, filters }) {
    this.config = config;
    this.client = client;
    this.broker = broker;
    this.logger = logger;
    this.filters = filters;
    this.cooldowns = {}; // symbol → timestamp da última entrada/saída
    this.running = false;
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

  async tick() {
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

    // 1) Gestão da posição aberta: stop/alvo (paper) ou sincronização (testnet).
    const closedTrade = await this.broker.onCandle(symbol, forming);
    if (closedTrade) this.cooldowns[symbol] = Date.now();

    // 2) Análise do último candle fechado.
    const res = analyze(closed, this.config.strategy);
    const s = res.snapshot;
    const painel = s
      ? `preço ${forming.close} | EMA${this.config.strategy.emaFast} ${s.emaFast.toFixed(2)} / EMA${this.config.strategy.emaSlow} ${s.emaSlow.toFixed(2)} | RSI ${s.rsi.toFixed(1)}`
      : `preço ${forming.close}`;
    if (res.signal) this.logger.info(`[${symbol}] ${painel} | >>> SINAL ${res.signal.toUpperCase()}: ${res.reason}`);
    else this.logger.info(`[${symbol}] ${painel} | ${res.reason}`);

    // 3) Com posição aberta: opcionalmente fecha em cruzamento contrário.
    if (this.broker.hasPosition(symbol)) {
      if (this.config.closeOnOppositeSignal) {
        const pos = this.broker.getPosition(symbol);
        const contrario = (pos.side === 'long' && res.crossedDown) || (pos.side === 'short' && res.crossedUp);
        if (contrario) {
          await this.broker.close(symbol, forming.close, 'cruzamento contrário');
          this.cooldowns[symbol] = Date.now();
        }
      }
      return;
    }

    // 4) Sem posição: avalia entrada.
    if (!res.signal) return;

    this.broker.rolloverDay();
    if (this.broker.isCircuitBroken()) {
      this.logger.warn(`[${symbol}] sinal ignorado: trava de perda diária ativada (${this.config.maxDailyLossPct}% no dia) — novas entradas só amanhã`);
      return;
    }
    if (this.broker.openPositionsCount() >= this.config.maxOpenPositions) {
      this.logger.info(`[${symbol}] sinal ignorado: limite de ${this.config.maxOpenPositions} posições simultâneas atingido`);
      return;
    }
    const last = this.cooldowns[symbol];
    if (last && Date.now() - last < this.config.cooldownMinutes * 60_000) {
      this.logger.info(`[${symbol}] sinal ignorado: aguardando ${this.config.cooldownMinutes}min de intervalo entre operações`);
      return;
    }

    const balance = await this.broker.balanceForRisk();
    const price = forming.close;
    const sized = computeQty({
      balance,
      price,
      stopDistance: res.stopDistance,
      riskPct: this.config.riskPerTradePct,
      leverage: this.config.leverage,
      filters: this.filters[symbol],
    });
    if (!sized.qty) {
      this.logger.warn(`[${symbol}] sinal ignorado: ${sized.reason}`);
      return;
    }
    const { sl, tp } = stopAndTarget({
      side: res.signal,
      entryPrice: price,
      stopDistance: res.stopDistance,
      riskReward: this.config.strategy.riskReward,
      filters: this.filters[symbol],
    });

    const opened = await this.broker.open({ symbol, side: res.signal, qty: sized.qty, price, sl, tp, reason: res.reason });
    if (opened) this.cooldowns[symbol] = Date.now();
  }
}
