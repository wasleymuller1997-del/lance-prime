import { buildStatus, readTrades } from './status.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Espelha o status do robô no site do LancePrime (painel /robocrypto) e
// executa os comandos enfileirados lá (encerrar posição, pausar, retomar).
// O robô sempre INICIA a conexão (só tráfego de saída), então funciona de
// qualquer rede doméstica sem abrir porta nenhuma.
//
// Ativação via .env:
//   RELAY_URL=https://lanceprimecards.com
//   RELAY_KEY=mesmo valor da env ROBO_KEY do servidor
export function startRelay({ bot, broker, client, config, logger }) {
  const url = (process.env.RELAY_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.RELAY_KEY || '').trim();
  if (!url || !key) return null;

  const intervalMs = 7_000;
  let conectado = false;
  let falhasSeguidas = 0;

  async function executeCommand(cmd) {
    if (cmd.action === 'close' && cmd.symbol) {
      logger.info(`Painel do site: pedido para encerrar ${cmd.symbol}`);
      await bot.closeManual(cmd.symbol);
    } else if (cmd.action === 'pause') {
      bot.pause();
      logger.info('Painel do site: novas entradas PAUSADAS');
    } else if (cmd.action === 'resume') {
      bot.resume();
      logger.info('Painel do site: novas entradas RETOMADAS');
    }
  }

  async function tick() {
    const state = await buildStatus({ bot, broker, client, config });
    state.trades = readTrades(config, 15);
    const res = await fetch(`${url}/api/robocrypto/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Robo-Key': key },
      body: JSON.stringify(state),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    for (const cmd of data.commands || []) {
      try {
        await executeCommand(cmd);
      } catch (err) {
        logger.error(`falha ao executar comando do site (${cmd.action} ${cmd.symbol || ''}): ${err.message}`);
      }
    }
  }

  (async () => {
    logger.info(`Relay do site ativado: espelhando status em ${url}/robocrypto`);
    for (;;) {
      try {
        await tick();
        if (!conectado) {
          conectado = true;
          falhasSeguidas = 0;
          logger.info('Relay do site: conectado');
        }
      } catch (err) {
        falhasSeguidas += 1;
        if (conectado || falhasSeguidas === 1 || falhasSeguidas % 20 === 0) {
          logger.warn(`Relay do site indisponível (${err.message}) — tentando de novo a cada ${intervalMs / 1000}s`);
        }
        conectado = false;
      }
      await sleep(intervalMs);
    }
  })();
  return true;
}
