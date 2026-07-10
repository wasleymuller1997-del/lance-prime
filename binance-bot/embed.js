// Modo EMBUTIDO: roda o robô dentro do servidor do site (backend do
// LancePrime), sem painel local e sem relay HTTP — o status vai direto pra
// rota /api/robocrypto pelo callback `report`, que devolve os comandos
// enfileirados pelo painel (encerrar, pausar, retomar).
//
// Por padrão sobe em modo paper (simulado). Para operar na conta demo real,
// defina no servidor: BOT_MODE=testnet, BINANCE_API_KEY e BINANCE_API_SECRET.
// Para desligar o robô embutido: ROBO_EMBEDDED=off.
//
// Atenção: em hospedagens com disco efêmero, o histórico do modo paper
// (data/state.json) zera a cada deploy. No modo testnet o estado que importa
// fica na corretora, então sobrevive normalmente.
import path from 'node:path';
import { loadConfig, ROOT } from './src/config.js';
import { createLogger } from './src/logger.js';
import { BinanceFutures, extractFilters } from './src/binanceRest.js';
import { PaperBroker } from './src/paperBroker.js';
import { TestnetBroker } from './src/testnetBroker.js';
import { Bot } from './src/bot.js';
import { buildStatus, readTrades } from './src/status.js';

export async function startEmbedded({ report }) {
  if (typeof report !== 'function') throw new Error('startEmbedded precisa do callback report(state) → commands[]');

  const config = loadConfig();
  const logger = createLogger(path.join(ROOT, 'logs'));
  logger.info(`[embutido] Robô iniciando dentro do servidor do site | modo ${config.mode.toUpperCase()} | ${config.symbols.join(', ')} | ${config.interval}`);

  const client = new BinanceFutures({ apiKey: config.apiKey, apiSecret: config.apiSecret, network: 'testnet' });
  const info = await client.exchangeInfo();
  const filters = {};
  for (const symbol of config.symbols) filters[symbol] = extractFilters(info, symbol);

  const broker = config.mode === 'paper'
    ? new PaperBroker({ config, logger })
    : new TestnetBroker({ client, config, filters, logger });
  await broker.init();

  const bot = new Bot({ config, client, broker, logger, filters });

  // Espelha o status no painel e executa comandos, a cada 7s.
  async function mirror() {
    try {
      const state = await buildStatus({ bot, broker, client, config });
      state.trades = readTrades(config, 15);
      state.embedded = true;
      const cmds = report(state) || [];
      for (const cmd of cmds) {
        try {
          if (cmd.action === 'close' && cmd.symbol) {
            logger.info(`[embutido] painel pediu para encerrar ${cmd.symbol}`);
            await bot.closeManual(cmd.symbol);
          } else if (cmd.action === 'pause') {
            bot.pause();
            logger.info('[embutido] painel PAUSOU novas entradas');
          } else if (cmd.action === 'resume') {
            bot.resume();
            logger.info('[embutido] painel RETOMOU novas entradas');
          }
        } catch (err) {
          logger.error(`[embutido] falha ao executar comando (${cmd.action} ${cmd.symbol || ''}): ${err.message}`);
        }
      }
    } catch (err) {
      logger.warn(`[embutido] espelhamento falhou: ${err.message}`);
    }
  }
  setInterval(mirror, 7_000);
  mirror();

  bot.start().catch((err) => logger.error(`[embutido] loop do robô caiu: ${err.message}`));
  return bot;
}
