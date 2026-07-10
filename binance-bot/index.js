import path from 'node:path';
import { loadConfig, ROOT } from './src/config.js';
import { createLogger } from './src/logger.js';
import { BinanceFutures, extractFilters } from './src/binanceRest.js';
import { PaperBroker } from './src/paperBroker.js';
import { TestnetBroker } from './src/testnetBroker.js';
import { Bot } from './src/bot.js';
import { startDashboard } from './src/server.js';
import { startRelay } from './src/relay.js';

const config = loadConfig();
const logger = createLogger(path.join(ROOT, 'logs'));

logger.info('================================================');
logger.info('  Robô Binance Futures — CONTA DEMO (testnet)');
logger.info('================================================');
if (config.mode === 'paper') {
  logger.info('Modo PAPER: operações 100% simuladas nesta máquina, com preços reais da testnet.');
} else {
  logger.info('Modo TESTNET: ordens reais enviadas para a sua conta demo da Binance.');
}

const client = new BinanceFutures({
  apiKey: config.apiKey,
  apiSecret: config.apiSecret,
  network: 'testnet',
});

const info = await client.exchangeInfo();
const filters = {};
for (const symbol of config.symbols) {
  filters[symbol] = extractFilters(info, symbol);
}

const broker = config.mode === 'paper'
  ? new PaperBroker({ config, logger })
  : new TestnetBroker({ client, config, filters, logger });
await broker.init();

const bot = new Bot({ config, client, broker, logger, filters });
startDashboard({ bot, broker, client, config, logger });
startRelay({ bot, broker, client, config, logger });

let interrupts = 0;
process.on('SIGINT', () => {
  interrupts += 1;
  if (interrupts === 1) {
    logger.info('Encerrando após o ciclo atual... (Ctrl+C de novo para forçar)');
    bot.stop();
  } else {
    process.exit(1);
  }
});

await bot.start();
