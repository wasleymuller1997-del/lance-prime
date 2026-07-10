import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Carrega variáveis de um .env simples (KEY=VALOR), sem sobrescrever o ambiente.
function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function loadConfig() {
  loadDotEnv();
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

  config.mode = (process.env.BOT_MODE || config.mode || 'paper').toLowerCase();
  if (!['paper', 'testnet'].includes(config.mode)) {
    throw new Error(`modo inválido: ${config.mode} (use "paper" ou "testnet")`);
  }
  config.apiKey = process.env.BINANCE_API_KEY || '';
  config.apiSecret = process.env.BINANCE_API_SECRET || '';

  if (!Array.isArray(config.symbols) || config.symbols.length === 0) {
    throw new Error('config.json precisa de pelo menos um símbolo em "symbols"');
  }
  return config;
}
