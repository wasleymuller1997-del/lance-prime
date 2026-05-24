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
let _mupdfP, _tesseractWorker;

async function getMupdf() {
  if (!_mupdfP) _mupdfP = import('mupdf');
  return _mupdfP;
}

async function getTesseract() {
  if (_tesseractWorker) return _tesseractWorker;
  const { createWorker } = require('tesseract.js');
  const path = require('path');
  // Trained data está bundlado em backend/assets/tessdata/ — evita download
  // em cold start e funciona em filesystems read-only (Render/Lambda).
  const langPath = path.resolve(__dirname, '..', '..', 'assets', 'tessdata');
  _tesseractWorker = await createWorker('por', undefined, {
    langPath,
    cachePath: langPath,
    gzip: false,
  });
  return _tesseractWorker;
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
  const mupdf = await getMupdf();
  const worker = await getTesseract();

  const srcDoc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');
  const pageCount = srcDoc.countPages();
  const pdfLibDoc = await PDFDocument.load(pdfBuffer, { updateMetadata: false, ignoreEncryption: true });

  const SCALE = 200 / 72; // 200 DPI pra OCR ter qualidade decente
  let anyRedacted = false;

  for (let i = 0; i < pageCount; i++) {
    const page = srcDoc.loadPage(i);
    const pix = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB);
    const imgW = pix.getWidth();
    const imgH = pix.getHeight();
    const pngBuf = Buffer.from(pix.asPNG());

    const { data } = await worker.recognize(pngBuf, {}, { blocks: true });

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
        new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timeout 45s')), 45000)),
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

module.exports = { sanitizeText, redactDealerFromPdf, redactDealerFromPdfFull };
