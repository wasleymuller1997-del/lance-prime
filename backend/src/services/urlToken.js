/**
 * Tokens opacos pra URLs de origem (fotos, laudo) que entregariam o fornecedor.
 *
 * Hoje o site público embute o link cru no HTML:
 *     /api/img?url=https://...dealersclub.com.br/foto.jpg
 * Qualquer um aperta F12 e descobre a Dealers. Aqui a gente cifra a URL num
 * token opaco (AES-256-GCM) e o navegador só vê:
 *     /api/img?t=<token>
 * O link real fica só no servidor — sem precisar de banco nem config nova:
 * a chave é derivada do JWT_SECRET, que é estável entre reinícios/instâncias.
 *
 * IV determinístico (HMAC da própria URL) → a mesma URL gera sempre o mesmo
 * token, então o cache do navegador (Cache-Control) continua funcionando.
 */

const crypto = require('crypto');

const KEY = crypto.scryptSync(
  process.env.JWT_SECRET || 'lanceprime-url-token-fallback',
  'lp-url-token-v1',
  32
);

// Hosts que entregam o fornecedor. cloudfront/amazonaws/fipe ficam de fora
// (CDN genérico), MAS qualquer URL que contenha "dealer" no texto é cifrada
// mesmo assim — pega bucket tipo dealersclub-prod.s3.amazonaws.com.
const SENSITIVE_HOSTS = ['dealersclub.com.br', 'dealers.club', 'manus.space'];

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function encodeUrlToken(url) {
  const iv = crypto.createHmac('sha256', KEY).update(url).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return b64url(Buffer.concat([iv, tag, ct]));
}

function decodeUrlToken(token) {
  try {
    const raw = fromB64url(token);
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function isSensitiveUrl(str) {
  if (typeof str !== 'string' || !/^https?:\/\//i.test(str)) return false;
  if (/dealer/i.test(str)) return true;
  try {
    const host = new URL(str).hostname;
    return SENSITIVE_HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

// Deep-walk: devolve uma cópia trocando toda string-URL sensível por seu token.
// Usado no boundary das respostas públicas pra garantir que o link cru nunca sai.
function tokenizeSensitiveUrls(value) {
  if (typeof value === 'string') {
    return isSensitiveUrl(value) ? encodeUrlToken(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map(tokenizeSensitiveUrls);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = tokenizeSensitiveUrls(value[k]);
    return out;
  }
  return value;
}

module.exports = { encodeUrlToken, decodeUrlToken, isSensitiveUrl, tokenizeSensitiveUrls };
