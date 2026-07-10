import fs from 'node:fs';
import path from 'node:path';

export function createLogger(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bot.log');

  function write(level, msg) {
    const line = `${new Date().toISOString()} [${level}] ${msg}`;
    console.log(line);
    try {
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      // sem espaço em disco ou permissão: segue só com o console
    }
  }

  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('AVISO', m),
    error: (m) => write('ERRO', m),
    trade: (m) => write('TRADE', m),
  };
}
