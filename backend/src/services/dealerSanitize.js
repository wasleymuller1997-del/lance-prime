/**
 * Utilitário pra remover referências à Dealers Club de textos e PDFs
 * que serão mostrados pro cliente final.
 *
 * Os anúncios vêm da API Dealers com nome/CNPJ/URLs/HUBs dela embutidos —
 * a gente filtra antes de exibir no site público (lanceprimecards.com).
 */

const { PDFDocument, PDFRawStream, PDFName, decodePDFRawStream, rgb } = require('pdf-lib');
const zlib = require('zlib');
const crypto = require('crypto');

// Patterns aplicados em string. A ordem importa — colocamos os mais específicos
// primeiro pra evitar matches parciais (ex.: "DEALERS - SUZANO" antes de "DEALERS").
const TEXT_PATTERNS = [
  /DEALERS\s+CLUB(\s+S\.?A\.?)?/gi,
  /DEALERS\s*[-–]\s*[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þa-zà-öø-þ]+(?:\s+[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þa-zà-öø-þ]+)*/g,
  /https?:\/\/[a-z0-9.-]*dealersclub\.com\.br[^\s)\]]*/gi,
  /(?:www\.)?[a-z0-9.-]*dealersclub\.com\.br/gi,
  /09\.?\s*143\.?\s*812\s*\/?\s*0001-?\s*60/g,
  /DEALERS?/gi,
];

function sanitizeText(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  for (const re of TEXT_PATTERNS) out = out.replace(re, '');
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// Patterns aplicados sobre texto JÁ DECODIFICADO de cada string em um content stream
// (literal entre parênteses ou hex entre `<...>`). Substituímos por espaços do MESMO
// comprimento — preserva a estrutura do stream (TJ arrays com offsets etc.) e a
// quantidade de glifos no PDF.
const PDF_TEXT_PATTERNS = [
  /DEALERS\s+CLUB(\s+S\.?A\.?)?/gi,
  /DEALERS\s*[-–]\s*[A-ZÀ-ÖØ-Þa-zà-öø-þ ]+/g,
  /https?:\/\/[a-z0-9.-]*dealersclub\.com\.br[^\s)\]]*/gi,
  /(?:www\.)?[a-z0-9.-]*dealersclub\.com\.br/gi,
  /09\.?\s*143\.?\s*812\s*\/?\s*0001-?\s*60/g,
  /DEALERS?/gi,
];

function applyTextPatterns(s) {
  let out = s;
  let modified = false;
  for (const re of PDF_TEXT_PATTERNS) {
    const next = out.replace(re, (m) => ' '.repeat(m.length));
    if (next !== out) { modified = true; out = next; }
  }
  return { str: out, modified };
}

function decodeHex(hex) {
  const clean = hex.replace(/\s+/g, '');
  const padded = clean.length % 2 ? clean + '0' : clean;
  let result = '';
  for (let i = 0; i < padded.length; i += 2) {
    result += String.fromCharCode(parseInt(padded.substr(i, 2), 16));
  }
  return result;
}

function encodeHexSameWidth(str, origHexWidth) {
  // Re-encode em uppercase contínuo. Garante o MESMO número de chars hex que
  // o original — se o original tinha espaços/quebras, achatamos (mas o comprimento
  // de string PDF resultante é determinado pelos bytes decodificados, não pelos
  // espaços em branco no encoding).
  let hex = '';
  for (let i = 0; i < str.length; i++) {
    hex += str.charCodeAt(i).toString(16).padStart(2, '0').toUpperCase();
  }
  // Se hex < origHexWidth (porque o original tinha whitespace), padroniza com zeros
  // — nunca deveria acontecer pois decodificamos com mesmo número de bytes.
  return hex;
}

function redactStreamString(str) {
  let anyModified = false;

  // Hex strings: <DEADBEEF...>. Exclui dict markers `<<...>>`.
  let out = str.replace(/<(?!<)([0-9A-Fa-f\s]+)>/g, (m, body) => {
    const decoded = decodeHex(body);
    const { str: cleaned, modified } = applyTextPatterns(decoded);
    if (!modified) return m;
    anyModified = true;
    return '<' + encodeHexSameWidth(cleaned, body.replace(/\s+/g, '').length) + '>';
  });

  // String literals: (texto). Lida com escapes básicos pra não quebrar no meio.
  out = out.replace(/\(((?:\\.|[^\\()])*)\)/g, (m, body) => {
    // Decodifica escapes mais comuns só pra detecção
    const decoded = body
      .replace(/\\\\/g, '\\')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
    const { modified } = applyTextPatterns(decoded);
    if (!modified) return m;
    anyModified = true;
    // Replace char-by-char preservando escapes: aplicamos os patterns ao body
    // bruto, que é seguro pois nossos termos (DEALERS, URLs, CNPJ) não contêm
    // backslash/parêntese.
    let newBody = body;
    for (const re of PDF_TEXT_PATTERNS) {
      newBody = newBody.replace(re, (mm) => ' '.repeat(mm.length));
    }
    return '(' + newBody + ')';
  });

  return { str: out, modified: anyModified };
}

/**
 * Carrega o PDF, varre todos os streams (decodificando FlateDecode quando preciso),
 * substitui ocorrências dos termos da Dealers por espaços e re-salva.
 * pdf-lib cuida de recalcular /Length e a xref pra gente.
 *
 * Se algo der errado, retorna o buffer original — o cliente nunca fica
 * sem ver o laudo.
 */
async function redactDealerFromPdf(pdfBuffer) {
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBuffer, { updateMetadata: false, ignoreEncryption: true });
  } catch (e) {
    console.warn('[redactDealerFromPdf] load falhou, devolvendo original:', e.message);
    return pdfBuffer;
  }

  let anyModified = false;
  const refs = pdfDoc.context.enumerateIndirectObjects();
  for (const [, obj] of refs) {
    if (!(obj instanceof PDFRawStream)) continue;

    let decoded;
    try {
      decoded = decodePDFRawStream(obj).decode();
    } catch {
      continue; // imagens, fontes binárias, etc.
    }

    const asStr = Buffer.from(decoded).toString('binary');
    const { str, modified } = redactStreamString(asStr);
    if (!modified) continue;

    const newBytes = Buffer.from(str, 'binary');

    // Re-comprime com FlateDecode pra manter o PDF compacto e os offsets razoáveis.
    let compressed;
    try {
      compressed = zlib.deflateSync(newBytes);
    } catch {
      continue;
    }

    obj.contents = compressed;
    obj.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    obj.dict.delete(PDFName.of('DecodeParms'));
    anyModified = true;
  }

  if (!anyModified) return pdfBuffer;

  // Limpa metadados que costumam expor "Dealers" em /Title, /Producer, /Author etc.
  const info = pdfDoc.context.lookup(pdfDoc.context.trailerInfo.Info);
  if (info && typeof info.set === 'function') {
    for (const key of ['Title', 'Author', 'Subject', 'Keywords', 'Producer', 'Creator']) {
      const v = info.get?.(PDFName.of(key));
      const raw = v && typeof v.asString === 'function' ? v.asString() : null;
      if (raw && /dealer/i.test(raw)) {
        info.delete?.(PDFName.of(key));
      }
    }
  }

  const saved = await pdfDoc.save({ useObjectStreams: false });
  return Buffer.from(saved);
}

// === Redação via OCR (pra PDFs que renderizam texto como vetor, ex.: Print To PDF) ===
//
// Alguns geradores (Microsoft Print To PDF, certos relatórios profissionais)
// rasterizam o texto em paths Bezier — não há ASCII em lugar nenhum no PDF.
// Pra esses casos, rasterizamos cada página, rodamos Tesseract pra achar a
// posição visual de "DEALERS" e desenhamos um retângulo branco por cima.
//
// Caro (~5s por página na primeira chamada — Tesseract carrega o modelo), então:
//   - Só rodamos quando a redação por texto (acima) não modificou nada
//   - Cacheamos o PDF redacted em memória por hash do PDF original

const ocrCache = new Map();
const OCR_CACHE_MAX = 200;

// Lazy-load: mupdf é ESM, Tesseract carrega o modelo pesado.
let _mupdfP, _tesseractP;

async function getMupdf() {
  if (!_mupdfP) {
    const t0 = Date.now();
    _mupdfP = import('mupdf').then(m => {
      console.log('[OCR] mupdf carregado em', Date.now() - t0, 'ms');
      return m;
    });
  }
  return _mupdfP;
}

async function getTesseract() {
  if (_tesseractP) return _tesseractP;
  _tesseractP = (async () => {
    const t0 = Date.now();
    const { createWorker } = require('tesseract.js');
    const path = require('path');
    const fs = require('fs');
    // Trained data bundlado em backend/assets/tessdata/. Se por algum motivo
    // não estiver lá (build sem o arquivo, deploy parcial), tesseract.js baixa
    // o modelo da CDN.
    const langPath = path.resolve(__dirname, '..', '..', 'assets', 'tessdata');
    const traineddata = path.join(langPath, 'por.traineddata');
    const bundled = fs.existsSync(traineddata);
    console.log('[OCR] inicializando Tesseract, langPath=', langPath, 'bundled=', bundled);
    const worker = await createWorker('por', undefined, {
      langPath,
      cachePath: langPath,
      gzip: false,
    });
    console.log('[OCR] Tesseract pronto em', Date.now() - t0, 'ms');
    return worker;
  })();
  return _tesseractP;
}

// Pré-aquece em background no boot pra primeira request ser rápida.
// Não bloqueia o startup do servidor.
function warmupOcr() {
  Promise.all([getMupdf(), getTesseract()]).catch(e => {
    console.warn('[OCR] warmup falhou:', e.message);
  });
}

const OCR_REDACT_PATTERNS = [
  /dealer/i,
  /dealersclub/i,
  /09\.?\s*143\.?\s*812/,
];

function shouldRedactLine(text) {
  return OCR_REDACT_PATTERNS.some(re => re.test(text));
}

async function redactByOcr(pdfBuffer) {
  const tAll = Date.now();
  const mupdf = await getMupdf();
  const worker = await getTesseract();

  const srcDoc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');
  const pageCount = srcDoc.countPages();
  const pdfLibDoc = await PDFDocument.load(pdfBuffer, { updateMetadata: false, ignoreEncryption: true });

  // 150 DPI: equilíbrio bom entre tempo e qualidade. 200 DPI ~2x mais lento.
  const SCALE = 150 / 72;
  let anyRedacted = false;
  let totalHits = 0;

  for (let i = 0; i < pageCount; i++) {
    const tPage = Date.now();
    const page = srcDoc.loadPage(i);
    const pix = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB);
    const imgW = pix.getWidth();
    const imgH = pix.getHeight();
    const pngBuf = Buffer.from(pix.asPNG());
    const tRender = Date.now() - tPage;

    const tOcr = Date.now();
    const { data } = await worker.recognize(pngBuf, {}, { blocks: true });
    console.log('[OCR] página', i + 1, 'render=', tRender, 'ms ocr=', Date.now() - tOcr, 'ms');

    // Coleta cada LINE que mencione dealer/CNPJ. Redige do x0 da palavra-gatilho
    // até o x1 da linha — preserva o label "Cliente:" / "Local:" à esquerda mas
    // apaga o valor à direita.
    const hits = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          if (!shouldRedactLine(line.text)) continue;
          const trigger = (line.words || []).find(w => shouldRedactLine(w.text));
          if (!trigger) continue;
          hits.push({
            x0: trigger.bbox.x0,
            y0: line.bbox.y0,
            x1: line.bbox.x1,
            y1: line.bbox.y1,
          });
        }
      }
    }
    totalHits += hits.length;
    if (hits.length === 0) continue;

    const pdfPage = pdfLibDoc.getPages()[i];
    const pw = pdfPage.getWidth();
    const ph = pdfPage.getHeight();
    for (const h of hits) {
      const x = (h.x0 / imgW) * pw;
      const y = ph - (h.y1 / imgH) * ph;
      const w = ((h.x1 - h.x0) / imgW) * pw;
      const hh = ((h.y1 - h.y0) / imgH) * ph;
      // Pequena margem extra pra cobrir antialiasing
      pdfPage.drawRectangle({
        x: Math.max(0, x - 1),
        y: Math.max(0, y - 1),
        width: w + 2,
        height: hh + 2,
        color: rgb(1, 1, 1),
      });
      anyRedacted = true;
    }
  }

  console.log('[OCR] total', Date.now() - tAll, 'ms,', totalHits, 'redactions,', pageCount, 'pages');
  if (!anyRedacted) return pdfBuffer;
  return Buffer.from(await pdfLibDoc.save({ useObjectStreams: false }));
}

/**
 * Pipeline completo: tenta redação textual primeiro (rápida); se nada bater,
 * cai pra OCR (lento mas funciona em qualquer PDF). Cacheia o resultado por hash.
 */
async function redactDealerFromPdfFull(pdfBuffer) {
  const hash = crypto.createHash('sha1').update(pdfBuffer).digest('hex');
  if (ocrCache.has(hash)) return ocrCache.get(hash);

  // 1. Tenta a redação por texto (rápida, funciona pra PDFs com texto real)
  const textRedacted = await redactDealerFromPdf(pdfBuffer);
  const textChanged = textRedacted !== pdfBuffer && textRedacted.length !== pdfBuffer.length;

  let final = textRedacted;
  if (!textChanged) {
    // 2. Fallback OCR pra PDFs vetorizados (Print to PDF etc.). Timeout
    // de 45s — se travar (modelo Tesseract não carrega, mupdf trava, etc.)
    // melhor devolver o PDF original do que pendurar a request indefinidamente.
    try {
      final = await Promise.race([
        redactByOcr(textRedacted),
        new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timeout 90s')), 90000)),
      ]);
    } catch (e) {
      console.warn('[redactByOcr] falhou:', e.message);
    }
  }

  // Cache LRU simples
  if (ocrCache.size >= OCR_CACHE_MAX) {
    const firstKey = ocrCache.keys().next().value;
    ocrCache.delete(firstKey);
  }
  ocrCache.set(hash, final);
  return final;
}

// === Cache permanente por URL (banco) + dedupe de requests concorrentes ===
//
// O laudo é redacted uma vez por URL e guardado no PostgreSQL (BYTEA). Assim:
//   - Sobrevive a reinícios do Render (cache em memória sozinho não sobrevive)
//   - OCR roda só na primeira vez na vida desse laudo
//   - Pré-aquecimento (quando a lista de veículos carrega) e clique do cliente
//     no mesmo laudo não rodam OCR duas vezes (inFlight dedupe)

const urlMemCache = new Map(); // url_hash -> Buffer (redacted)
const inFlight = new Map();     // url_hash -> Promise<Buffer>
const URL_MEM_MAX = 100;

function hashUrl(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

/**
 * Devolve o PDF do laudo já redacted pra uma URL. Usa cache em memória → banco
 * → (miss) baixa + redige + grava no banco. `downloadFn` recebe a URL e devolve
 * o Buffer do PDF original (injetado pela rota, que faz a validação SSRF).
 */
async function getRedactedLaudo(sourceUrl, downloadFn) {
  const key = hashUrl(sourceUrl);

  if (urlMemCache.has(key)) return urlMemCache.get(key);
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    const { pool } = require('./db');

    // 1. Banco (permanente)
    try {
      const row = await pool.query('SELECT pdf_data FROM laudo_cache WHERE url_hash = $1', [key]);
      if (row.rows.length > 0) {
        const buf = row.rows[0].pdf_data;
        rememberUrl(key, buf);
        return buf;
      }
    } catch (e) {
      console.warn('[laudo cache] erro lendo banco:', e.message);
    }

    // 2. Miss: baixa + redige
    const original = await downloadFn(sourceUrl);
    const redacted = await redactDealerFromPdfFull(original);

    // 3. Grava no banco (best-effort) e memória
    try {
      await pool.query(
        `INSERT INTO laudo_cache (url_hash, source_url, pdf_data) VALUES ($1, $2, $3)
         ON CONFLICT (url_hash) DO UPDATE SET pdf_data = $3, created_at = NOW()`,
        [key, sourceUrl, redacted]
      );
    } catch (e) {
      console.warn('[laudo cache] erro gravando banco:', e.message);
    }
    rememberUrl(key, redacted);
    return redacted;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

function rememberUrl(key, buf) {
  if (urlMemCache.size >= URL_MEM_MAX) {
    urlMemCache.delete(urlMemCache.keys().next().value);
  }
  urlMemCache.set(key, buf);
}

/**
 * Pré-aquece (fire-and-forget) — usado quando a lista de veículos carrega, pra
 * que o laudo já esteja pronto quando o cliente clicar. Nunca lança.
 */
function prewarmLaudo(sourceUrl, downloadFn) {
  const key = hashUrl(sourceUrl);
  if (urlMemCache.has(key) || inFlight.has(key)) return;
  getRedactedLaudo(sourceUrl, downloadFn).catch(e => {
    console.warn('[prewarmLaudo] falhou:', e.message);
  });
}

module.exports = {
  sanitizeText,
  redactDealerFromPdf,
  redactDealerFromPdfFull,
  warmupOcr,
  getRedactedLaudo,
  prewarmLaudo,
};
