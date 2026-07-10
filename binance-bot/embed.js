// Modo EMBUTIDO: roda o robô dentro do servidor do site (backend do
// LancePrime), sem painel local e sem relay HTTP — o status vai direto pra
// rota /api/robocrypto pelo callback `report`, que devolve os comandos
// enfileirados pelo painel (encerrar, pausar, retomar).
//
// Com "variants" no config.json (modo paper), sobe UM robô por tempo gráfico,
// cada um com banca própria — uma competição de estratégias que o painel
// mostra como placar. No modo testnet roda sempre uma instância única.
//
// Envs: BOT_MODE=testnet + BINANCE_API_KEY/SECRET ativam a conta demo real;
// ROBO_EMBEDDED=off desliga o robô embutido.
//
// Atenção: em hospedagens com disco efêmero, o histórico do modo paper
// (data/state*.json) zera a cada deploy. No modo testnet o estado que importa
// fica na corretora, então sobrevive normalmente.
import path from 'node:path';
import { loadConfig, ROOT } from './src/config.js';
import { createLogger } from './src/logger.js';
import { BinanceFutures, extractFilters } from './src/binanceRest.js';
import { PaperBroker } from './src/paperBroker.js';
import { TestnetBroker } from './src/testnetBroker.js';
import { Bot } from './src/bot.js';
import { buildStatus, readTrades } from './src/status.js';

function taggedLogger(logger, tag) {
  if (!tag) return logger;
  return {
    info: (m) => logger.info(`[${tag}] ${m}`),
    warn: (m) => logger.warn(`[${tag}] ${m}`),
    error: (m) => logger.error(`[${tag}] ${m}`),
    trade: (m) => logger.trade(`[${tag}] ${m}`),
  };
}

export async function startEmbedded({ report, storage = null }) {
  if (typeof report !== 'function') throw new Error('startEmbedded precisa do callback report(state) → commands[]');

  const base = loadConfig();
  const logger = createLogger(path.join(ROOT, 'logs'));

  // Banco de dados do site: saldos, posições e histórico sobrevivem a deploys.
  if (storage) {
    try {
      await storage.init?.();
      logger.info('[embutido] persistência no banco de dados ativa — deploys não zeram mais a competição');
    } catch (err) {
      logger.warn(`[embutido] banco indisponível (${err.message}) — usando arquivos locais (zeram no deploy)`);
      storage = null;
    }
  }

  const useVariants = base.mode === 'paper' && Array.isArray(base.variants) && base.variants.length > 0;
  const variants = useVariants ? base.variants : [{ id: null, interval: base.interval }];
  logger.info(`[embutido] Iniciando ${variants.length} robô(s) dentro do servidor | modo ${base.mode.toUpperCase()} | ${base.symbols.join(', ')} | ${variants.map((v) => v.interval).join(', ')}`);

  const client = new BinanceFutures({ apiKey: base.apiKey, apiSecret: base.apiSecret, network: 'testnet' });
  const info = await client.exchangeInfo();
  const filters = {};
  for (const symbol of base.symbols) filters[symbol] = extractFilters(info, symbol);

  const units = [];
  for (const v of variants) {
    const config = {
      ...base,
      interval: v.interval,
      cooldownMinutes: v.cooldownMinutes ?? base.cooldownMinutes,
      riskPerTradePct: v.riskPerTradePct ?? base.riskPerTradePct,
      leverage: v.leverage ?? base.leverage,
      strategy: { ...base.strategy, ...(v.strategy || {}) },
    };
    const log = taggedLogger(logger, v.id);
    const broker = config.mode === 'paper'
      ? new PaperBroker({ config, logger: log, id: v.id, storage })
      : new TestnetBroker({ client, config, filters, logger: log });
    await broker.init();
    const bot = new Bot({ config, client, broker, logger: log, filters, id: v.id, storage });
    await bot.initState();
    units.push({ id: v.id || config.interval, interval: v.interval, config, broker, bot });
  }

  // Comandos aguardam os robôs completarem o primeiro ciclo (logo após um
  // deploy o processo novo recebia a fila e descartava, pois ainda não havia
  // posição carregada). Ficam na espera por até 2 minutos.
  let pendingCmds = [];
  const botsReady = () => units.every((u) => Object.keys(u.bot.lastAnalysis).length > 0);

  async function executeCommand(cmd) {
    try {
      const targets = cmd.account ? units.filter((u) => u.id === cmd.account) : units;
      if (cmd.action === 'close' && cmd.symbol) {
        for (const u of targets) {
          if (u.bot.broker.hasPosition(cmd.symbol)) {
            u.bot.logger.info(`painel pediu para encerrar ${cmd.symbol}`);
            await u.bot.closeManual(cmd.symbol);
          }
        }
      } else if (cmd.action === 'pause') {
        for (const u of units) u.bot.pause();
        logger.info('[embutido] painel PAUSOU novas entradas (todos os robôs)');
      } else if (cmd.action === 'resume') {
        for (const u of units) u.bot.resume();
        logger.info('[embutido] painel RETOMOU novas entradas (todos os robôs)');
      }
    } catch (err) {
      logger.error(`[embutido] falha ao executar comando (${cmd.action} ${cmd.symbol || ''}): ${err.message}`);
    }
  }

  // Espelha o status agregado no painel e executa comandos, a cada 7s.
  async function mirror() {
    try {
      const accounts = [];
      for (const u of units) {
        const st = await buildStatus({ bot: u.bot, broker: u.broker, client: u.bot.client, config: u.config });
        st.id = u.id;
        // histórico: prefere o registro persistido no banco; CSV é o fallback
        st.trades = u.broker.state?.tradeLog?.length
          ? u.broker.state.tradeLog.slice(0, 15)
          : readTrades(u.config, 15, u.config.mode === 'paper' && units.length > 1 ? u.id : null);
        accounts.push(st);
      }
      const state = {
        embedded: true,
        multi: units.length > 1,
        mode: base.mode,
        symbols: base.symbols,
        leverage: base.leverage,
        balance: accounts.reduce((s, a) => s + a.balance, 0),
        dayPnl: accounts.reduce((s, a) => s + a.dayPnl, 0),
        paused: accounts.every((a) => a.paused),
        accounts,
        updatedAt: Date.now(),
      };
      pendingCmds.push(...((report(state) || []).map((c) => ({ ...c, receivedAt: Date.now() }))));
      pendingCmds = pendingCmds.filter((c) => Date.now() - c.receivedAt < 120_000);
      if (pendingCmds.length && botsReady()) {
        const fila = pendingCmds;
        pendingCmds = [];
        for (const cmd of fila) await executeCommand(cmd);
      }
    } catch (err) {
      logger.warn(`[embutido] espelhamento falhou: ${err.message}`);
    }
  }
  setInterval(mirror, 7_000);
  mirror();

  for (const u of units) {
    u.bot.start().catch((err) => logger.error(`[embutido:${u.id}] loop do robô caiu: ${err.message}`));
  }
  return units;
}
