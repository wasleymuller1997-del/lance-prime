// scrape-catalog.js
// Extrai o catálogo completo da loja MGA Figurinhas (plataforma Tray/TCDN).
// Lê o sitemap, visita cada página de produto e exporta catalog/catalogo.{json,csv}.
//
// Uso: node scrape-catalog.js
// Sem dependências externas — usa o fetch nativo do Node 18+.

const fs = require('fs');
const path = require('path');

const BASE = 'https://www.mgafigurinhas.com.br';
const SITEMAP = `${BASE}/loja/arquivos/1457323/sitemaps/sitemap_1.xml`;
const OUT_DIR = path.join(__dirname, 'catalog');
const CONCURRENCY = 6;
const UA = 'Mozilla/5.0 (compatible; LancePrimeCatalogExport/1.0)';

// Prefixos de URL que correspondem a produtos (o resto do sitemap são páginas
// institucionais: contato, garantia, quem-somos, etc).
const PRODUCT_PREFIXES = ['/figurinhas/', '/legends/', '/selecoes/', '/souvenirs/', '/coca-cola/', '/album/'];

// Decodifica páginas servidas em ISO-8859-1 (latin1) e respeita as entidades
// nomeadas mais comuns em português que aparecem nas tabelas em HTML.
function decode(buf) {
  return new TextDecoder('iso-8859-1').decode(buf);
}

const ENTITIES = {
  '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú',
  '&acirc;': 'â', '&ecirc;': 'ê', '&ocirc;': 'ô', '&atilde;': 'ã', '&otilde;': 'õ',
  '&agrave;': 'à', '&ccedil;': 'ç', '&Aacute;': 'Á', '&Eacute;': 'É', '&Iacute;': 'Í',
  '&Oacute;': 'Ó', '&Uacute;': 'Ú', '&Atilde;': 'Ã', '&Otilde;': 'Õ', '&Ccedil;': 'Ç',
  '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&#39;': "'",
};
function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&[a-zA-Z]+;/g, (e) => ENTITIES[e] ?? e)
    .trim();
}

async function fetchPage(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return decode(Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      if (i === tries) throw e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** (i - 1)));
    }
  }
}

// Extrai o objeto `dataLayer = [{...}]` da página fazendo varredura balanceada
// de colchetes/chaves (respeitando strings), e retorna o primeiro objeto.
function extractDataLayer(html) {
  const i = html.indexOf('dataLayer = [');
  if (i === -1) return null;
  const start = i + 'dataLayer = '.length; // aponta para o '['
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, j + 1))[0]; } catch { return null; }
      }
    }
  }
  return null;
}

function matchField(html, label) {
  const re = new RegExp(label + '\\s*</td>\\s*<td>\\s*([^<]+?)\\s*</td>', 'i');
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : '';
}

function parseProduct(url, html) {
  const dl = extractDataLayer(html) || {};
  const ogDesc = (html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/i) || [])[1] || '';
  const estoque = matchField(html, 'Estoque');
  const referencia = matchField(html, 'Refer&ecirc;ncia') || matchField(html, 'Referência');
  return {
    codigo: dl.idProduct || '',
    nome: decodeEntities(dl.nameProduct || (html.match(/<meta\s+property="og:title"\s+content="([^"]*?)(?:\s+-\s+MGA Figurinhas)?"/i) || [])[1] || ''),
    categoria: decodeEntities(dl.category || ''),
    referencia,
    preco: dl.price || '',
    preco_venda: dl.priceSell || '',
    em_promocao: dl.promotion && dl.promotion !== 'NO' ? 'SIM' : 'NAO',
    estoque: estoque || '',
    disponivel: dl.availability === 'YES' ? 'SIM' : 'NAO',
    url_imagem: (dl.urlImage || '').replace(/\\\//g, '/'),
    url_produto: url,
    descricao: decodeEntities(ogDesc === '-' ? '' : ogDesc),
  };
}

const CSV_COLS = [
  ['codigo', 'Código'], ['nome', 'Nome'], ['categoria', 'Categoria'], ['referencia', 'Referência'],
  ['preco', 'Preço'], ['preco_venda', 'Preço de venda'], ['em_promocao', 'Em promoção'],
  ['estoque', 'Estoque'], ['disponivel', 'Disponível'], ['url_imagem', 'URL imagem'],
  ['url_produto', 'URL produto'], ['descricao', 'Descrição'],
];
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) {
  const head = CSV_COLS.map(([, h]) => csvCell(h)).join(';');
  const body = rows.map((r) => CSV_COLS.map(([k]) => csvCell(r[k])).join(';'));
  return '﻿' + [head, ...body].join('\r\n'); // BOM para abrir certo no Excel
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0, done = 0;
  async function loop() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx], idx);
      done++;
      if (done % 25 === 0 || done === items.length) {
        process.stdout.write(`\r  ${done}/${items.length} produtos...`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, loop));
  process.stdout.write('\n');
  return results;
}

async function main() {
  console.log('Baixando sitemap...');
  const xml = await fetchPage(SITEMAP);
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1].trim());
  const productUrls = [...new Set(locs.filter((u) => {
    const p = u.replace(BASE, '');
    return PRODUCT_PREFIXES.some((pre) => p.startsWith(pre));
  }))];
  console.log(`Encontrados ${productUrls.length} produtos no sitemap (de ${locs.length} URLs).`);

  const products = [];
  const errors = [];
  await runPool(productUrls, async (url) => {
    try {
      const html = await fetchPage(url);
      const p = parseProduct(url, html);
      if (!p.codigo && !p.nome) throw new Error('sem dados de produto');
      products.push(p);
    } catch (e) {
      errors.push({ url, error: e.message });
    }
  }, CONCURRENCY);

  products.sort((a, b) => (a.categoria + a.nome).localeCompare(b.categoria + b.nome, 'pt-BR'));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'catalogo.json'), JSON.stringify(products, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'catalogo.csv'), toCsv(products));

  // Resumo por categoria
  const porCat = {};
  for (const p of products) porCat[p.categoria || '(sem)'] = (porCat[p.categoria || '(sem)'] || 0) + 1;

  console.log(`\nExtraídos ${products.length} produtos. Arquivos em catalog/`);
  console.log('Por categoria:');
  for (const [c, n] of Object.entries(porCat).sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);
  if (errors.length) {
    fs.writeFileSync(path.join(OUT_DIR, 'erros.json'), JSON.stringify(errors, null, 2));
    console.log(`\n${errors.length} URLs falharam (ver catalog/erros.json).`);
  }
}

main().catch((e) => { console.error('Erro:', e); process.exit(1); });
