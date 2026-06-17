const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { PDFDocument, rgb } = require('pdf-lib');
const dealers = require('../services/dealers');
const { requireApproved, requireBidEligible, requireAdmin } = require('./auth');
const { pool } = require('../services/db');
const { sanitizeText, getRedactedLaudo, prewarmLaudo } = require('../services/dealerSanitize');

// === IDs OPACOS PRA IMAGENS / IDS NUMÉRICOS DA FONTE ===
// HMAC determinístico (mesma URL -> mesmo id) pra não expor a CDN/fornecedor.
const IMAGE_URL_SECRET = process.env.IMAGE_URL_SECRET || ('lp-img-fallback:' + (process.env.JWT_SECRET || 'no-secret'));
if (!process.env.IMAGE_URL_SECRET) {
  console.warn('[image] IMAGE_URL_SECRET não configurado — usando fallback. Defina no .env pra produção.');
}
const imageUrlMemMap = new Map(); // id -> url (cache em memória)

function makeOpaqueImageId(url) {
  return crypto.createHmac('sha256', IMAGE_URL_SECRET).update('img:' + String(url)).digest('hex').slice(0, 16);
}
function makeMaskedId(n) {
  if (n == null || n === '') return null;
  return crypto.createHmac('sha256', IMAGE_URL_SECRET).update('id:' + String(n)).digest('hex').slice(0, 8);
}

// Reescreve a URL pra /api/img/<id> sem bloquear: registra em memória sincronamente
// e persiste no banco em fire-and-forget (sobrevive a restart).
function rewriteImageUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('/api/img/')) return url; // já é opaca
  const id = makeOpaqueImageId(url);
  if (!imageUrlMemMap.has(id)) {
    imageUrlMemMap.set(id, url);
    try {
      pool.query(
        'INSERT INTO image_url_map (id, url) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
        [id, url]
      ).catch(err => console.warn('[image_url_map] persist falhou:', err.message));
    } catch (_) {}
  }
  return '/api/img/' + id;
}

async function resolveOpaqueImageId(id) {
  if (imageUrlMemMap.has(id)) return imageUrlMemMap.get(id);
  try {
    const r = await pool.query('SELECT url FROM image_url_map WHERE id = $1', [id]);
    if (r.rows.length > 0) {
      const url = r.rows[0].url;
      imageUrlMemMap.set(id, url);
      return url;
    }
  } catch (e) {
    console.warn('[image_url_map] lookup falhou:', e.message);
  }
  return null;
}

// Validação crítica: JWT_SECRET obrigatório
if (!process.env.JWT_SECRET) {
  console.error('ERRO CRÍTICO: JWT_SECRET não configurado!');
}

// === WHITELIST DE DOMÍNIOS PERMITIDOS PARA PROXY ===
const ALLOWED_PROXY_DOMAINS = [
  'dealersclub.com.br',
  'dealers.club',
  's3.amazonaws.com',
  'cloudfront.net',
  'fipe.org.br',
  'vendasdiretaspremium.manus.space',
  'manus.space'
];

function isAllowedUrl(urlString) {
  try {
    const url = new URL(urlString);
    return ALLOWED_PROXY_DOMAINS.some(domain =>
      url.hostname === domain || url.hostname.endsWith('.' + domain)
    );
  } catch {
    return false;
  }
}

// === CACHE PARA REDUZIR REQUISIÇÕES À DEALERS CLUB ===
// Cache em memória com TTL de 5 segundos para veículos por evento
const dealersCache = new Map();
const CACHE_TTL = 5000; // 5 segundos

// A Dealers REMOVE o evento da própria lista quando ele encerra. Pra conseguir
// manter o evento visível como "ENCERRADO" por um tempo depois, guardamos os
// eventos que já vimos e reexibimos os que sumiram do feed (dentro da janela).
// Persistimos no banco (events_cache) pra sobreviver a restart do servidor.
const seenEventsCache = new Map(); // id -> objeto do evento

let seenEventsLoaded = null;
function loadSeenEventsFromDb() {
  if (seenEventsLoaded) return seenEventsLoaded;
  seenEventsLoaded = (async () => {
    try {
      const { pool } = require('../services/db');
      const result = await pool.query('SELECT raw FROM events_cache');
      result.rows.forEach(row => {
        if (row.raw && row.raw.id != null) seenEventsCache.set(row.raw.id, row.raw);
      });
      console.log('[events_cache] carregados', result.rows.length, 'eventos do banco');
    } catch (e) {
      console.warn('[events_cache] erro carregando:', e.message);
    }
  })();
  return seenEventsLoaded;
}

function persistSeenEvent(e) {
  if (!e || e.id == null) return;
  try {
    const { pool } = require('../services/db');
    // fire-and-forget — não bloqueia a resposta
    pool.query(
      'INSERT INTO events_cache (id, raw, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO UPDATE SET raw = $2, updated_at = NOW()',
      [e.id, e]
    ).catch(err => console.warn('[events_cache] upsert falhou:', err.message));
  } catch (_) {}
}

// Requisições em voo são deduplicadas: se vários clientes derem poll ao mesmo
// tempo num cache expirado, sai UMA só chamada à origem e todos recebem o mesmo
// resultado. Sem isso, baixar o intervalo de poll multiplicaria a carga na Dealers.
const inFlight = new Map();
function getCachedOrFetch(key, fetchFn, ttl) {
  const maxAge = ttl != null ? ttl : CACHE_TTL;
  const cached = dealersCache.get(key);
  if (cached && (Date.now() - cached.timestamp) < maxAge) {
    return Promise.resolve(cached.data);
  }
  if (inFlight.has(key)) return inFlight.get(key);
  const p = fetchFn().then(data => {
    dealersCache.set(key, { data, timestamp: Date.now() });
    inFlight.delete(key);
    return data;
  }).catch(err => {
    inFlight.delete(key);
    throw err;
  });
  inFlight.set(key, p);
  return p;
}

// API FIPE oficial (fipe.online) - 1000 consultas/dia grátis
const FIPE_API = 'https://api.fipe.online/api/v2';
const FIPE_TOKEN = process.env.FIPE_API_TOKEN;
const fipeMemCache = new Map();
// Última vez que disparamos o pré-aquecimento de FIPE por evento (throttle).
const fipePrewarmAt = new Map();

// Cache em memória das respostas cruas da fipe.online (marcas/modelos/anos
// mudam ~1x/mês) + retry com backoff. Isso reduz drasticamente as chamadas
// e absorve 429/timeout esporádicos sem deixar a requisição pendurada.
const fipeRawCache = new Map();
const FIPE_RAW_TTL = 12 * 60 * 60 * 1000;

async function fipeGet(path) {
  const hit = fipeRawCache.get(path);
  if (hit && Date.now() - hit.ts < FIPE_RAW_TTL) return hit.data;

  // Auth via header x-api-key (NÃO "Authorization: Bearer" — esse a fipe.online
  // rejeita com 429 mesmo com token válido; foi a causa do 429 persistente).
  // Timeout curto + poucas tentativas: nenhuma chamada pendura por muito tempo.
  const headers = {};
  if (FIPE_TOKEN) headers['x-api-key'] = FIPE_TOKEN;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await axios.get(FIPE_API + path, { headers, timeout: 7000 });
      fipeRawCache.set(path, { ts: Date.now(), data: res.data });
      return res.data;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status === 429 || status === 503 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
        await new Promise(r => setTimeout(r, 500 + Math.floor(Math.random() * 300)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function normalize(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[\/-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Câmbio/combustível/portas: a FIPE descreve ("Total Flex 5p Aut.") e a Dealers
// costuma omitir, ou cada um escreve de um jeito. Não são discriminantes de versão,
// então neutralizamos (canonizamos sinônimos e removemos do cálculo) — era a causa
// principal de match CORRETO cair abaixo de 0.7 e virar "FIPE não confirmada".
const FIPE_FILLER = new Set([
  'aut', 'manual', 'flex', 'gasolina', 'diesel',
  'portas', 'porta', 'p', '2p', '3p', '4p', '5p',
]);

function canonToken(t) {
  if (['automatico', 'automatica', 'tiptronic', 'dsg', 'cvt', 'at'].includes(t)) return 'aut';
  if (['mecanico', 'mec'].includes(t)) return 'manual';
  if (['etanol', 'alcool', 'total'].includes(t)) return 'flex';
  return t;
}

// Abreviações que a Dealers usa mas a FIPE escreve por extenso (ou em outra
// abreviação). Sem expandir isso o match fica "aproximado" (cai abaixo de 0.7
// ou vai pra versão errada — Highline virava Comfortline e a comparação FIPE
// ficava enganosa: dizia "acima da FIPE" quando na real estava abaixo).
//
// VW: HL/CL/TL/BL → trim level por extenso.
// Jeep: TF (Turbo Flex) — "flex" cai no filtro, sobra "turbo".
// FIPE costuma escrever TB (Turbo abreviado) — canonizamos os dois pro mesmo
// token, assim "LONG TF" da Dealers casa com "T270 1.3 TB Flex Aut." da FIPE.
// Toyota: compostos como CDSR (Cabine Dupla SR) — a FIPE escreve separado.
const TRIM_ABBREV = {
  hl: 'highline',
  cl: 'comfortline',
  tl: 'trendline',
  bl: 'bluemotion',
  tf: 'turbo',
  tb: 'turbo',
  // Toyota Hilux — compostos cabine + trim. Expandem pra 2 tokens.
  cdsr: 'cd sr',
  cdsrv: 'cd srv',
  cdsrx: 'cd srx',
  cssr: 'cs sr',
  cssrv: 'cs srv',
  cssrx: 'cs srx',
  ccsr: 'cc sr',
  ccsrv: 'cc srv',
};
function expandTrimAbbrev(t) {
  return TRIM_ABBREV[t] || t;
}

// Tokens curtos (lt, ls, gl, xe, tsi) precisam bater EXATO — senão "LT" casaria
// com "LTZ" via substring e geraria match confiante porém errado.
function tokenMatch(a, b) {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  if (shorter.length < 4) return false;
  return a.includes(b) || b.includes(a);
}

function discriminativeTokens(s) {
  // flatMap porque algumas abreviações compostas (CDSR → "cd sr") expandem
  // pra 2 tokens — precisa quebrar de novo no espaço pra cair certo no filtro.
  return s.split(/\s+/)
    .flatMap(t => expandTrimAbbrev(canonToken(t)).split(/\s+/))
    .filter(w => w.length > 1 && !FIPE_FILLER.has(w));
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.95;

  const engineRegex = /\b(\d\.\d)\b/;
  const engineA = na.match(engineRegex);
  const engineB = nb.match(engineRegex);
  if (engineA && engineB && engineA[1] !== engineB[1]) {
    return 0.1;
  }

  const tsiRegex = /(\d{3})\s*tsi/;
  const tsiA = na.match(tsiRegex);
  const tsiB = nb.match(tsiRegex);
  if (tsiA && tsiB && tsiA[1] !== tsiB[1]) {
    return 0.1;
  }

  const wordsSearch = discriminativeTokens(nb);
  const wordsTarget = discriminativeTokens(na);
  if (wordsSearch.length === 0) return 0.3;
  let matches = 0;

  for (const w of wordsSearch) {
    if (wordsTarget.some(wt => tokenMatch(wt, w))) {
      matches++;
    }
  }

  return matches / wordsSearch.length;
}

async function fetchFipeValue(brand, model, version, year) {
  const cacheKey = `${brand}|${model}|${version}|${year}`.toLowerCase();

  // 1. Verificar cache em memória
  if (fipeMemCache.has(cacheKey)) {
    console.log('FIPE: Cache memória hit');
    return fipeMemCache.get(cacheKey);
  }

  // Detecta se a versão tem alguma abreviação que a gente passou a expandir
  // (HL/CL/TL/BL). Cache antigo dessas versões pode estar com match errado
  // (Highline caiu em Comfortline, etc.) — se o score for baixo, vale a pena
  // refazer pra pegar o match certo.
  const versionTokens = (version || '').toLowerCase().split(/[\s\/-]+/);
  const hasAbbrev = versionTokens.some(t => TRIM_ABBREV[t]);

  // 2. Verificar cache no banco de dados (válido por 30 dias)
  try {
    const dbCache = await pool.query(
      `SELECT * FROM fipe_cache WHERE cache_key = $1 AND updated_at > NOW() - INTERVAL '30 days'`,
      [cacheKey]
    );
    if (dbCache.rows.length > 0) {
      const row = dbCache.rows[0];
      const cachedScore = parseFloat(row.match_score);
      // Se a versão tem abreviação E o match cacheado não é perfeito (< 0.95),
      // ignora o cache e refaz a busca — assim o Nivus HL para de comparar com
      // Comfortline e acerta no Highline real.
      if (hasAbbrev && (isNaN(cachedScore) || cachedScore < 0.95)) {
        console.log('FIPE: ignorando cache de baixa confiança pra refazer com expansão de abreviação', cacheKey);
      } else {
        const result = {
          value: parseFloat(row.fipe_value),
          model: row.fipe_model,
          year: row.year,
          reference: row.fipe_reference,
          fipeCode: row.fipe_code,
          matchScore: row.match_score
        };
        fipeMemCache.set(cacheKey, result);
        console.log('FIPE: Cache DB hit para', cacheKey);
        return result;
      }
    }
  } catch (err) {
    console.log('FIPE: Erro ao buscar cache DB:', err.message);
  }

  // 3. Buscar na API FIPE oficial
  console.log('FIPE: Buscando na API', { brand, model, version, year });

  const categories = ['cars', 'motorcycles'];
  for (const categoryType of categories) {
    try {
      const marcas = await fipeGet(`/${categoryType}/brands`);
      const brandNorm = normalize(brand);
      const marca = marcas.find(m => normalize(m.name) === brandNorm)
        || marcas.find(m => normalize(m.name).includes(brandNorm) || brandNorm.includes(normalize(m.name)));

      if (!marca) continue;

      const modelos = await fipeGet(`/${categoryType}/brands/${marca.code}/models`);

      const searchStr = `${model} ${version}`.trim();
      const modelNorm = normalize(model);

      let candidates = [];
      for (const m of modelos) {
        const mNorm = normalize(m.name);
        if (!mNorm.includes(modelNorm)) continue;
        const score = similarity(m.name, searchStr);
        if (score >= 0.3) candidates.push({ model: m, score });
      }

      if (candidates.length === 0) {
        for (const m of modelos) {
          const score = similarity(m.name, searchStr);
          if (score >= 0.3) candidates.push({ model: m, score });
        }
      }
      candidates.sort((a, b) => b.score - a.score);

      for (const candidate of candidates) {
        try {
          const anos = await fipeGet(`/${categoryType}/brands/${marca.code}/models/${candidate.model.code}/years`);
          const yearStr = String(year);
          let ano = anos.find(a => a.code.startsWith(yearStr + '-'));
          if (!ano) ano = anos.find(a => a.name.includes(yearStr));
          if (!ano) continue;

          const data = await fipeGet(`/${categoryType}/brands/${marca.code}/models/${candidate.model.code}/years/${ano.code}`);
          const valorNum = parseFloat(data.price.replace('R$ ', '').replace(/\./g, '').replace(',', '.'));
          const result = { value: valorNum, model: data.model, year: data.modelYear, reference: data.referenceMonth, fipeCode: data.codeFipe, matchScore: candidate.score.toFixed(2) };

          // Salvar no cache em memória
          fipeMemCache.set(cacheKey, result);

          // Salvar no banco de dados
          try {
            await pool.query(
              `INSERT INTO fipe_cache (cache_key, brand, model, version, year, fipe_value, fipe_model, fipe_code, fipe_reference, match_score)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT (cache_key) DO UPDATE SET
               fipe_value = $6, fipe_model = $7, fipe_code = $8, fipe_reference = $9, match_score = $10, updated_at = NOW()`,
              [cacheKey, brand, model, version, year, result.value, result.model, result.fipeCode, result.reference, result.matchScore]
            );
            console.log('FIPE: Salvo no cache DB');
          } catch (dbErr) {
            console.log('FIPE: Erro ao salvar cache DB:', dbErr.message);
          }

          return result;
        } catch (err) {
          continue;
        }
      }
    } catch (err) {
      console.error('FIPE error:', err.message);
      continue;
    }
  }
  return null;
}


// Baixa o PDF original de uma URL já validada (SSRF). Usado pelo cache.
async function downloadLaudoPdf(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
  return Buffer.from(response.data);
}

router.get('/laudo-proxy', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send('URL required');

    if (!isAllowedUrl(url)) {
      console.warn('SSRF bloqueado: tentativa de acesso a URL não permitida:', url);
      return res.status(403).send('URL não permitida');
    }

    // Cache permanente por URL: 1ª vez baixa+redige+grava no banco; depois instantâneo.
    const cleaned = await getRedactedLaudo(url, downloadLaudoPdf);

    res.set('Content-Type', 'application/pdf');
    // Cache curtíssimo no browser (60s): o trabalho pesado fica no cache do
    // servidor (banco), e cache curto evita o cliente ficar preso numa versão
    // antiga do laudo (importante enquanto ajustamos a redação).
    res.set('Cache-Control', 'public, max-age=60');
    res.send(cleaned);
  } catch (err) {
    console.error('Laudo proxy error:', err.message);
    // Fallback: tenta servir o original direto
    try {
      const original = await downloadLaudoPdf(req.query.url);
      res.set('Content-Type', 'application/pdf');
      return res.send(original);
    } catch {
      res.status(500).send('Error processing PDF');
    }
  }
});

// Rota nova: serve a imagem por ID opaco (não revela a CDN/fornecedor).
router.get('/img/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!/^[a-f0-9]{8,64}$/.test(id)) return res.status(400).send('invalid id');
    const url = await resolveOpaqueImageId(id);
    if (!url) return res.status(404).send('not found');
    if (!isAllowedUrl(url)) {
      console.warn('SSRF bloqueado em /img/:id:', url);
      return res.status(403).send('not allowed');
    }
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (err) {
    res.status(404).send('Image not found');
  }
});

// Legado: /api/img?url=... — mantido por compat com páginas abertas antes do
// novo esquema. Aceita a URL bruta e proxia. Será removida no futuro.
router.get('/img', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send('URL required');
    if (!isAllowedUrl(url)) {
      console.warn('SSRF bloqueado em /img:', url);
      return res.status(403).send('URL não permitida');
    }
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (err) {
    res.status(404).send('Image not found');
  }
});

router.get('/events', async (req, res) => {
  try {
    const events = await getCachedOrFetch('events', () => dealers.getEvents());
    const now = new Date();

    // As datas da Dealers vêm em horário de Brasília (ex.: "2026-05-27 20:00:00").
    // O servidor (Render) roda em UTC, então new Date(str) leria como UTC e ficaria
    // 3h adiantado — era por isso que o noturno sumia ao vivo e as margens não
    // batiam. Forçamos o offset de Brasília (-03:00) pra comparar com o "agora" real.
    function parseBrt(s) {
      if (!s) return new Date(NaN);
      return new Date(String(s).replace(' ', 'T') + '-03:00');
    }

    function exclusionReason(e) {
      const finish = parseBrt(e.finish_date_display);
      // +3h: o evento continua visível por 3h depois de encerrar (o cliente gosta
      // de ainda ver), exibido como "ENCERRADO" e sem cronômetro (ver frontend).
      const margin = new Date(finish.getTime() + 3 * 60 * 60 * 1000);
      if (margin < now) return 'encerrado (finish_date_display + 3h < agora)';
      const nameLower = (e.name || '').toLowerCase();
      if (nameLower.includes('cancelado')) return 'nome contém "cancelado"';
      if (nameLower.includes('vinculos')) return 'nome contém "vinculos"';
      if (nameLower.includes('pesado')) return 'nome contém "pesado"';
      if (nameLower.includes('implemento')) return 'nome contém "implemento"';
      return null;
    }

    // Diagnóstico: /api/events?debug=1 mostra a lista CRUA da Dealers + motivo
    // de cada exclusão. Não expõe dado sensível (só nome/datas do evento).
    if (req.query.debug === '1') {
      const arr = Array.isArray(events) ? events : (events && events.data) || [];
      return res.json({
        success: true,
        now: now.toISOString(),
        total_recebidos: arr.length,
        eventos: arr.map(e => ({
          id: e.id,
          name: (e.name || '').replace(/dealers\s*club(\s+s\.?a\.?)?/gi, '').replace(/dealers/gi, '').replace(/\s{2,}/g, ' ').trim(),
          finish_date_display: e.finish_date_display,
          finish_date_event: e.finish_date_event,
          excluido_por: exclusionReason(e),
        })),
      });
    }

    // Carrega o cache persistente do banco (só uma vez por boot do servidor).
    await loadSeenEventsFromDb();

    // Lembra os eventos que a Dealers mandou agora, em memória e no banco.
    events.forEach(e => {
      if (e && e.id != null) {
        seenEventsCache.set(e.id, e);
        persistSeenEvent(e);
      }
    });

    // Reexibe eventos que a Dealers REMOVEU do feed (ela tira quando encerram),
    // enquanto ainda estiverem dentro da janela (finish_date_display + 3h). Assim
    // o evento não some na hora que acaba — fica como ENCERRADO até a janela passar.
    const presentIds = new Set(events.map(e => e && e.id));
    const reinjected = [];
    for (const [id, ev] of seenEventsCache) {
      if (presentIds.has(id)) continue;
      const keepUntil = parseBrt(ev.finish_date_display).getTime() + 3 * 60 * 60 * 1000;
      if (!isNaN(keepUntil) && now.getTime() <= keepUntil) reinjected.push(ev);
      else {
        seenEventsCache.delete(id); // passou da janela: limpa
        try {
          const { pool } = require('../services/db');
          pool.query('DELETE FROM events_cache WHERE id = $1', [id]).catch(() => {});
        } catch (_) {}
      }
    }

    const filtered = events.concat(reinjected).filter(e => exclusionReason(e) === null);
    filtered.sort((a, b) => new Date(a.finish_date_event) - new Date(b.finish_date_event));

    // Resposta enxuta e sem vazar a origem: só os campos que o frontend usa,
    // com o nome do evento já com "Dealers"/"Dealers Club" removidos.
    const cleanName = (s) => (s || '')
      .replace(/dealers\s*club(\s+s\.?a\.?)?/gi, '')
      .replace(/dealers/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const dataForClient = filtered.map(e => ({
      id: e.id,
      name: cleanName(e.name),
      finish_date_event: e.finish_date_event,
      finish_date_display: e.finish_date_display,
      start_date_offer: e.start_date_offer,
      start_date_display: e.start_date_display,
    }));
    res.json({ success: true, data: dataForClient });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/events/:eventId', async (req, res) => {
  try {
    const event = await getCachedOrFetch(`event_${req.params.eventId}`, () => dealers.getEventDetails(req.params.eventId));
    res.json({ success: true, data: event });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function extractInfo(description) {
  if (!description) return { location: null, comitente: null, plate: null, uf: null };
  let location = null;
  let comitente = null;
  let plate = null;
  let uf = null;
  const locMatch = description.match(/LOCALIZA[ÇC][ÃA]O:\s*([^\/\n]+)\/([A-Z]{2})/i);
  if (locMatch) {
    location = locMatch[1].trim();
    uf = locMatch[2].trim().toUpperCase();
  } else {
    const locMatch2 = description.match(/LOCALIZA[ÇC][ÃA]O:\s*([^\/\n]+)/i);
    if (locMatch2) location = locMatch2[1].trim();
  }
  const comMatch = description.match(/COMITENTE:\s*([^\/\n]+)/i);
  if (comMatch) comitente = comMatch[1].trim();
  const plateMatch = description.match(/PLACA[:\s]+([A-Z]{3}[\-\s]?\d[A-Z0-9]\d{2})/i);
  if (plateMatch) plate = plateMatch[1].trim().toUpperCase();
  return { location, comitente, plate, uf };
}

// Spread de 5% aplicado nos preços exibidos ao cliente
const SPREAD = 0.05;

function applySpread(value) {
  if (!value || isNaN(value)) return value;
  return Math.round(value * (1 + SPREAD));
}

function removeSpread(value) {
  if (!value || isNaN(value)) return value;
  return Math.round(value / (1 + SPREAD));
}

router.get('/events/:eventId/vehicles', async (req, res) => {
  try {
    // Cache curto (3s) só pra absorver picos de poll simultâneo sem deixar os
    // dados velhos no leilão ao vivo. Combinado com o dedup acima, a origem é
    // consultada no máximo ~1x a cada 3s por evento, mesmo com muitos clientes.
    const vehicles = await getCachedOrFetch(`vehicles_${req.params.eventId}`, () => dealers.getEventVehicles(req.params.eventId), 3000);
    const mapped = vehicles.map(v => {
      const rawDescription = v.vehicle.description || '';
      // Sanitiza ANTES de extrair info — mas a extração só procura por LOCALIZAÇÃO,
      // COMITENTE e PLACA, então a sanitização (que tira só DEALERS/URLs/CNPJ) não afeta.
      const info = extractInfo(rawDescription);
      const cleanDescription = sanitizeText(rawDescription);
      const neg = { ...v.negotiation };
      // Aplicar spread nos valores de negociação
      neg.value_actual = applySpread(neg.value_actual);
      neg.value_initial = applySpread(neg.value_initial);
      if (neg.immediate_sale_price) neg.immediate_sale_price = applySpread(neg.immediate_sale_price);
      neg.increment = applySpread(neg.increment);

      // Aplicar spread na oferta atual + mascarar ids da fonte (shop_id/user_id
      // identificavam a conta usada — agora vão como hash opaco).
      let offerActual = v.offer_actual ? { ...v.offer_actual } : null;
      if (offerActual) {
        if (offerActual.price) offerActual.price = applySpread(offerActual.price);
        if (offerActual.shop) offerActual.shop = { id: makeMaskedId(offerActual.shop.id) };
        if (offerActual.user) offerActual.user = { id: makeMaskedId(offerActual.user.id) };
      }

      // Reescreve as URLs das imagens pra IDs opacos (esconde a CDN da fonte).
      // Limita a 8 fotos: a grade da catálogo mostra só 1, o carrossel suporta
      // até 8 dots. Mandar as 28 lotava 300KB de strings no DOM × 100 cards =
      // memória demais no iOS Safari, que matava a aba. Pra detalhe completo,
      // existe rota separada que retorna todas as fotos.
      const galleryClean = (v.vehicle.image_gallery || []).slice(0, 8).map(g => ({
        ...g,
        image: g.image ? rewriteImageUrl(g.image) : g.image,
        thumb: g.thumb ? rewriteImageUrl(g.thumb) : g.thumb,
      }));
      const vehicleClean = {
        ...v.vehicle,
        image_gallery: galleryClean,
      };

      return {
        id: v.id,
        vehicle: vehicleClean,
        // shop.name vinha como número (id da loja na origem) — substituído por
        // um rótulo genérico pra não vazar o identificador na tela "Vendedor".
        shop: { name: 'Loja parceira', city: v.shop.city, state: info.uf || v.shop.state },
        negotiation: neg,
        offers: v.offers,
        offer_actual: offerActual,
        situation: v.situation,
        is_favorite: v.is_favorite,
        precautionary_report: v.vehicle.precautionary_report || null,
        location: info.location,
        comitente: info.comitente,
        plate: info.plate,
        description: cleanDescription || null
      };
    });

    // OBS.: o pré-aquecimento em massa dos laudos foi DESLIGADO. Com o OCR
    // rodando sempre, pré-processar ~175 laudos em background estourava a
    // memória do Render (502 Bad Gateway). Agora o laudo é redigido sob demanda
    // (na 1ª vez que o cliente clica em "Ver Laudo") e fica cacheado por URL —
    // um de cada vez, sem derrubar o servidor.

    // FIPE: anexa o valor já em cache (1 query em lote, sem bater na API externa)
    // pra o badge do site público renderizar instantâneo junto com o card —
    // acaba a cascata de N chamadas /fipe/valor. Os que não estão em cache são
    // pré-aquecidos em background (stagger) pra já ficarem prontos na próxima visita.
    const fipeKeys = mapped.map(m => {
      const vh = m.vehicle || {};
      if (!vh.brand_name || !vh.model_name || !vh.model_year) return null;
      return `${vh.brand_name}|${vh.model_name}|${vh.version_name || ''}|${vh.model_year}`.toLowerCase();
    });
    const uniqueKeys = [...new Set(fipeKeys.filter(Boolean))];
    const fipeByKey = {};
    if (uniqueKeys.length) {
      try {
        const r = await pool.query(
          `SELECT * FROM fipe_cache WHERE cache_key = ANY($1) AND updated_at > NOW() - INTERVAL '30 days'`,
          [uniqueKeys]
        );
        r.rows.forEach(row => {
          fipeByKey[row.cache_key] = {
            value: parseFloat(row.fipe_value),
            model: row.fipe_model,
            matchScore: row.match_score,
            reference: row.fipe_reference,
            fipeCode: row.fipe_code
          };
        });
      } catch (err) {
        console.log('FIPE: erro no lookup em lote da lista:', err.message);
      }
    }
    mapped.forEach((m, i) => {
      const key = fipeKeys[i];
      if (key && fipeByKey[key]) m.fipe = fipeByKey[key];
    });
    // Pré-aquece (fire-and-forget) só os que faltam no cache. THROTTLE por evento:
    // com o poll a 3s, sem isso disparávamos uma nova leva de timers de FIPE a
    // cada 3s — foi o tipo de pressão de memória que já derrubou o Render (502).
    // Agora roda no máximo 1x a cada 30s por evento.
    const evId = req.params.eventId;
    const lastPrewarm = fipePrewarmAt.get(evId) || 0;
    if (Date.now() - lastPrewarm > 30000) {
      fipePrewarmAt.set(evId, Date.now());
      const fipeMisses = mapped.filter((m, i) => fipeKeys[i] && !fipeByKey[fipeKeys[i]]);
      fipeMisses.forEach((m, idx) => {
        const vh = m.vehicle;
        setTimeout(() => {
          fetchFipeValue(vh.brand_name, vh.model_name, vh.version_name || '', vh.model_year).catch(() => {});
        }, idx * 800);
      });
    }

    res.json({ success: true, data: mapped });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/vehicles/:advertisementId/offers', async (req, res) => {
  try {
    const offers = await dealers.getOffers(req.params.advertisementId);
    // Aplica o spread (mesmo markup do preço atual) e remove shop/user (privacidade).
    const data = (offers || [])
      .map(o => ({
        price: applySpread(parseFloat(o.price || o.value || 0)),
        created_at: o.created_at || o.date || null,
        // buyerId mascarado pra não vazar shop_id/user_id da origem.
        buyerId: makeMaskedId((o.user && o.user.id) || (o.shop && o.shop.id) || null)
      }))
      .filter(o => o.price > 0)
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/vehicles/:advertisementId/favorite', async (req, res) => {
  try {
    const result = await dealers.toggleFavorite(parseInt(req.params.advertisementId));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/vehicles/:advertisementId/bid', requireBidEligible, async (req, res) => {
  try {
    const { value, vehicleData } = req.body;
    if (!value) return res.status(400).json({ success: false, error: 'Valor obrigatório' });

    // Remove spread antes de enviar ao Dealers Club
    const realValue = removeSpread(value);
    const result = await dealers.placeBid(parseInt(req.params.advertisementId), realValue);

    // Salvar lance no banco local. CRITICO: salvar auction_end_date + snapshot
    // pro cron de reconciliacao saber quando checar resultado e pra preservar
    // o contexto do veiculo mesmo se a Dealers tirar o anuncio do feed depois.
    try {
      const { pool } = require('../services/db');
      const user = req.user || {};
      const endDate = (vehicleData && vehicleData.finish_date_offer) ? new Date(vehicleData.finish_date_offer) : null;
      const snapshotJson = vehicleData ? JSON.stringify({
        brand: vehicleData.brand || req.body.brand || '',
        model: vehicleData.model || req.body.model || '',
        version: vehicleData.version || '',
        year_manufacture: vehicleData.year_manufacture || null,
        year_model: vehicleData.year_model || null,
        km: vehicleData.km || 0,
        color: vehicleData.color || '',
        plate: vehicleData.plate || '',
        location: vehicleData.location || '',
        uf: vehicleData.uf || '',
        photo: (vehicleData.photos && vehicleData.photos[0]) || null,
        initial_price: vehicleData.initial_price || null,
      }) : null;
      await pool.query(
        `INSERT INTO bids (user_id, user_name, user_email, advertisement_id, vehicle_brand, vehicle_model, bid_value, bid_type, auction_end_date, vehicle_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [user.id || null, user.name || 'Cliente', user.email || '', parseInt(req.params.advertisementId), req.body.brand || '', req.body.model || '', value, 'manual', endDate, snapshotJson]
      );
    } catch(dbErr) { console.error('Erro ao salvar lance:', dbErr.message); }

    if (vehicleData) saveVehicleSnapshot(parseInt(req.params.advertisementId), vehicleData);

    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message;
    res.status(status).json({ success: false, error: message });
  }
});

router.post('/vehicles/:advertisementId/auto-bid', requireBidEligible, async (req, res) => {
  try {
    const { maxValue, tiebreaker, vehicleData } = req.body;
    if (!maxValue) return res.status(400).json({ success: false, error: 'Valor máximo obrigatório' });

    // Remove spread antes de enviar ao Dealers Club
    const realMaxValue = removeSpread(maxValue);
    const result = await dealers.placeAutoBid(parseInt(req.params.advertisementId), realMaxValue, tiebreaker || false);

    // Salvar lance no banco local (auto-bid). Mesmas colunas que o lance manual.
    try {
      const { pool } = require('../services/db');
      const user = req.user || {};
      const endDate = (vehicleData && vehicleData.finish_date_offer) ? new Date(vehicleData.finish_date_offer) : null;
      const snapshotJson = vehicleData ? JSON.stringify({
        brand: vehicleData.brand || req.body.brand || '',
        model: vehicleData.model || req.body.model || '',
        version: vehicleData.version || '',
        year_manufacture: vehicleData.year_manufacture || null,
        year_model: vehicleData.year_model || null,
        km: vehicleData.km || 0,
        color: vehicleData.color || '',
        plate: vehicleData.plate || '',
        location: vehicleData.location || '',
        uf: vehicleData.uf || '',
        photo: (vehicleData.photos && vehicleData.photos[0]) || null,
        initial_price: vehicleData.initial_price || null,
      }) : null;
      await pool.query(
        `INSERT INTO bids (user_id, user_name, user_email, advertisement_id, vehicle_brand, vehicle_model, bid_value, bid_type, auction_end_date, vehicle_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [user.id || null, user.name || 'Cliente', user.email || '', parseInt(req.params.advertisementId), req.body.brand || '', req.body.model || '', maxValue, 'automatico', endDate, snapshotJson]
      );
    } catch(dbErr) { console.error('Erro ao salvar auto-lance:', dbErr.message); }

    if (vehicleData) saveVehicleSnapshot(parseInt(req.params.advertisementId), vehicleData);

    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message;
    res.status(status).json({ success: false, error: message });
  }
});

router.post('/vehicles/:advertisementId/buy-now', requireBidEligible, async (req, res) => {
  try {
    const { value, vehicleData } = req.body;
    if (!value) return res.status(400).json({ success: false, error: 'Valor obrigatório' });

    // Remove spread antes de enviar ao Dealers Club
    const realValue = removeSpread(value);
    const result = await dealers.buyNow(parseInt(req.params.advertisementId), realValue);

    // Salvar no estoque automaticamente
    if (vehicleData) {
      try {
        const { pool } = require('../services/db');
        await pool.query(
          'INSERT INTO purchases (brand, model, version, year, km, color, price, sell_price, status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [vehicleData.brand || '', vehicleData.model || '', vehicleData.version || '', vehicleData.year || '', vehicleData.km || 0, vehicleData.color || '', realValue, 0, 'disponivel', 'Compra automatica via Compre Ja']
        );
      } catch(dbErr) { console.error('Erro ao salvar compra:', dbErr.message); }

      // Salvar snapshot do veículo
      saveVehicleSnapshot(parseInt(req.params.advertisementId), vehicleData);
    }

    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message;
    res.status(status).json({ success: false, error: message });
  }
});

router.get('/my-purchases', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const result = await pool.query('SELECT * FROM purchases ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Vitrine pública: lista só os veículos do "Meu Estoque" disponíveis pra revenda.
// Esconde: vendidos (sale_price preenchido), os escondidos manualmente, e dados
// sensíveis (preço de compra, custos, lucro). Mostra: foto, especs, preço de
// tabela (sell_price > fipe_price > null) — pra cliente final ver e dar lead
// via "Tenho interesse" no WhatsApp.
router.get('/my-stock-public', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const result = await pool.query(`
      SELECT p.id, p.brand, p.model, p.version, p.year, p.km, p.color,
             p.fuel, p.transmission, p.city,
             p.sell_price, p.fipe_price, p.photos, p.image, p.description
        FROM purchases p
        LEFT JOIN hidden_vehicles h ON h.vehicle_id = p.id
       WHERE h.vehicle_id IS NULL
         AND (p.status IS NULL OR p.status IN ('disponivel', 'em_estoque', 'em estoque', 'novo'))
         AND (p.sale_price IS NULL OR p.sale_price = 0)
       ORDER BY p.created_at DESC
    `);
    // Fotos custom em batch — usa as do lojista quando existirem (mais novas)
    const customRes = await pool.query(
      'SELECT id, vehicle_id FROM vehicle_photos_custom ORDER BY vehicle_id, display_order, id'
    );
    const customByVehicle = {};
    customRes.rows.forEach(r => {
      (customByVehicle[r.vehicle_id] = customByVehicle[r.vehicle_id] || []).push('/api/stock-photo/' + r.id);
    });
    const vehicles = result.rows.map(v => {
      let photos = customByVehicle[v.id] || [];
      if (photos.length === 0) {
        if (v.photos) {
          try {
            const parsed = JSON.parse(v.photos);
            if (Array.isArray(parsed)) photos = parsed.filter(Boolean);
          } catch (e) { /* ignora */ }
        }
        if (photos.length === 0 && v.image) photos = [v.image];
      }
      // Preço a exibir: sell_price (tabela de venda) > fipe (referência) > null
      const sell = parseFloat(v.sell_price) || 0;
      const fipe = parseFloat(v.fipe_price) || 0;
      const displayPrice = sell > 0 ? sell : (fipe > 0 ? fipe : null);
      return {
        id: v.id,
        brand: v.brand || '',
        model: v.model || '',
        version: v.version || '',
        year: v.year || '',
        km: v.km || 0,
        color: v.color || '',
        fuel: v.fuel || '',
        transmission: v.transmission || '',
        city: v.city || '',
        price: displayPrice,
        priceSource: sell > 0 ? 'tabela' : (fipe > 0 ? 'fipe' : null),
        photos: photos,
        description: v.description || ''
      };
    });
    res.json({ success: true, data: vehicles });
  } catch (err) {
    console.error('[my-stock-public] erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/dealers-purchases', async (req, res) => {
  try {
    const { pool } = require('../services/db');

    // Lê todos os veículos do banco local + total de custos + total já recebido.
    const result = await pool.query(`
      SELECT
        p.*,
        COALESCE((SELECT SUM(amount) FROM vehicle_costs WHERE vehicle_id = p.id), 0) AS total_costs,
        COALESCE((SELECT SUM(amount) FROM vehicle_receipts WHERE vehicle_id = p.id AND paid = TRUE), 0) AS total_received,
        COALESCE((SELECT SUM(amount) FROM vehicle_receipts WHERE vehicle_id = p.id AND paid = FALSE), 0) AS total_scheduled
      FROM purchases p
      LEFT JOIN hidden_vehicles h ON h.vehicle_id = p.id
      WHERE h.vehicle_id IS NULL
      ORDER BY p.created_at DESC
    `);

    // Busca todas as fotos custom de uma vez (1 query em lote em vez de N)
    const customRes = await pool.query(
      'SELECT id, vehicle_id FROM vehicle_photos_custom ORDER BY vehicle_id, display_order, id'
    );
    const customByVehicle = {};
    customRes.rows.forEach(r => {
      (customByVehicle[r.vehicle_id] = customByVehicle[r.vehicle_id] || []).push('/api/stock-photo/' + r.id);
    });

    const vehicles = [];
    for (const v of result.rows) {
      // Fotos próprias do lojista têm prioridade. Senão, as da Dealers.
      let photos = customByVehicle[v.id] || [];
      if (photos.length === 0) {
        if (v.photos) {
          try {
            const parsed = JSON.parse(v.photos);
            if (Array.isArray(parsed)) photos = parsed.filter(Boolean);
          } catch (e) { /* ignora JSON inválido */ }
        }
        if (photos.length === 0 && v.image) photos = [v.image];
      }

      // Busca FIPE se não tiver
      let fipePrice = parseFloat(v.fipe_price) || 0;
      if (!fipePrice && v.brand && v.model && v.year) {
        const fipeResult = await fetchFipeValue(v.brand, v.model, v.version || '', v.year);
        if (fipeResult) fipePrice = fipeResult.value;
      }

      const salePrice = v.sale_price != null ? parseFloat(v.sale_price) : null;
      const totalReceived = parseFloat(v.total_received) || 0;
      vehicles.push({
        id: v.id,
        brand: v.brand || '',
        model: v.model || '',
        version: v.version || '',
        year: v.year || '',
        km: v.km || 0,
        color: v.color || '',
        image: photos[0] || v.image || '',
        price: parseFloat(v.price) || 0,
        sell_price: parseFloat(v.sell_price) || 0,
        fipe_price: fipePrice,
        total_costs: parseFloat(v.total_costs) || 0,
        fuel: v.fuel || '',
        transmission: v.transmission || '',
        city: v.city || '',
        status: v.status || 'disponivel',
        purchase_date: v.purchase_date || v.created_at || null,
        description: v.description || '',
        dealers_code: v.dealers_code || null,
        dealers_uuid: v.dealers_uuid || null,
        laudo: v.laudo || null,
        photos: photos,
        // Venda fechada — só preenche se sale_price existe
        sale_price: salePrice,
        sold_date: v.sold_date,
        buyer_name: v.buyer_name,
        buyer_phone: v.buyer_phone,
        balance_due_date: v.balance_due_date,
        total_received: totalReceived,
        balance_remaining: salePrice != null ? Math.max(0, salePrice - totalReceived) : 0
      });
    }

    res.json({ success: true, data: vehicles });
  } catch (err) {
    console.error('dealers-purchases error:', err.message);
    res.json({ success: true, data: [], error: err.message });
  }
});

// Adicionar veículo ao estoque (banco local)
router.post('/add-to-stock', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { brand, model, version, year, km, color, price, sell_price, fuel, transmission, city, status, notes } = req.body;

    const result = await pool.query(
      `INSERT INTO purchases (
         brand, model, version, year, km, color, price, sell_price,
         fuel, transmission, city, status, notes, purchase_date
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        brand || '', model || '', version || '', String(year || ''),
        parseInt(km) || 0, color || '',
        parseFloat(price) || 0, parseFloat(sell_price) || 0,
        fuel || '', transmission || '', city || '',
        status || 'disponivel', notes || '',
        new Date().toISOString().split('T')[0]
      ]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Erro ao adicionar veículo:', err.message);
    res.json({ success: false, error: err.message });
  }
});

router.get('/stock-detail/:id', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const vId = parseInt(req.params.id);

    const vRes = await pool.query('SELECT * FROM purchases WHERE id = $1', [vId]);
    if (vRes.rows.length === 0) {
      return res.json({ success: false, error: 'Veículo não encontrado' });
    }
    const v = vRes.rows[0];

    // Parse das fotos: fotos PRÓPRIAS do lojista vêm PRIMEIRO (são as oficiais
    // depois que o carro foi pra loja). Se não tem custom, cai nas da Dealers.
    let photos = [];
    const customRes = await pool.query(
      'SELECT id FROM vehicle_photos_custom WHERE vehicle_id = $1 ORDER BY display_order, id',
      [vId]
    );
    if (customRes.rows.length > 0) {
      photos = customRes.rows.map(r => ({ url: '/api/stock-photo/' + r.id, custom: true, id: r.id }));
    } else {
      if (v.photos) {
        try {
          const parsed = JSON.parse(v.photos);
          if (Array.isArray(parsed)) photos = parsed.filter(Boolean).map(url => ({ url }));
        } catch (e) { /* ignora */ }
      }
      if (photos.length === 0 && v.image) photos = [{ url: v.image }];
    }

    // Custos — has_attachment é true se tem inline OU se referencia um anexo compartilhado
    const cRes = await pool.query(
      `SELECT id, category, description, amount, cost_date,
              (attachment_data IS NOT NULL OR attachment_id IS NOT NULL) AS has_attachment,
              attachment_type, attachment_name, attachment_id
         FROM vehicle_costs WHERE vehicle_id = $1 ORDER BY id`,
      [vId]
    );
    const costs = cRes.rows;

    // Recebimentos (entrada + parcelas do saldo). Soma define quanto já entrou.
    const rRes = await pool.query(
      'SELECT id, amount, received_date, notes, paid, created_at FROM vehicle_receipts WHERE vehicle_id = $1 ORDER BY received_date, id',
      [vId]
    );
    const receipts = rRes.rows;
    const totalReceived = receipts.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);

    // FIPE: usa o salvo, ou busca se faltar
    let fipe = null;
    if (v.fipe_price && parseFloat(v.fipe_price) > 0) {
      fipe = { fipePrice: String(v.fipe_price), fipeCode: null, modelName: `${v.brand} ${v.model}`, referenceMonth: null };
    } else if (v.brand && v.model && v.year) {
      const fipeResult = await fetchFipeValue(v.brand, v.model, v.version || '', v.year);
      if (fipeResult) {
        fipe = { fipePrice: String(fipeResult.value), fipeCode: fipeResult.fipeCode, modelName: fipeResult.model, referenceMonth: fipeResult.reference };
      }
    }

    const salePrice = parseFloat(v.sale_price) || 0;
    const downPayment = parseFloat(v.down_payment) || 0;
    // Saldo restante = (valor da venda) − (tudo que já entrou: entrada + parcelas).
    // A "entrada" é representada como o 1º recebimento na hora de marcar como vendido,
    // então totalReceived já cobre tudo.
    const balanceRemaining = salePrice > 0 ? Math.max(0, salePrice - totalReceived) : 0;

    const vehicle = {
      id: v.id,
      brand: v.brand,
      model: v.model,
      version: v.version,
      year: v.year,
      km: v.km,
      color: v.color,
      fuel: v.fuel,
      transmission: v.transmission,
      city: v.city,
      doors: v.doors,
      status: v.status,
      purchasePrice: parseFloat(v.price) || 0,
      sellPrice: parseFloat(v.sell_price) || 0,
      purchaseDate: v.purchase_date,
      description: v.description,
      notes: v.notes,
      dealers_code: v.dealers_code,
      dealers_uuid: v.dealers_uuid,
      laudo: v.laudo,
      // Venda fechada (status === 'vendido')
      salePrice,
      soldDate: v.sold_date,
      buyerName: v.buyer_name,
      buyerPhone: v.buyer_phone,
      downPayment,
      balanceDueDate: v.balance_due_date,
      paymentMethod: v.payment_method,
      totalReceived,
      balanceRemaining
    };

    res.json({ success: true, data: { vehicle, photos, fipe, costs, receipts } });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Atualiza um campo editavel de um veiculo no estoque.
// Whitelist de campos pra segurança (não deixa editar id, vdp_id, etc).
const EDITABLE_FIELDS = new Set(['km', 'sell_price', 'color', 'plate', 'status', 'notes', 'city', 'fuel', 'transmission']);
router.post('/stock-update-field', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { vehicleId, field, value } = req.body;
    if (!vehicleId || !field) return res.status(400).json({ success: false, error: 'vehicleId e field obrigatórios' });
    if (!EDITABLE_FIELDS.has(field)) return res.status(400).json({ success: false, error: 'Campo não editável: ' + field });

    let parsed = value;
    if (field === 'km' || field === 'sell_price') parsed = parseFloat(value) || 0;

    await pool.query(`UPDATE purchases SET ${field} = $1 WHERE id = $2`, [parsed, parseInt(vehicleId)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/stock-hide/:id', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    await pool.query('INSERT INTO hidden_vehicles (vehicle_id) VALUES ($1) ON CONFLICT (vehicle_id) DO NOTHING', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.delete('/stock-cost/:id', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const costId = parseInt(req.params.id);
    await pool.query('DELETE FROM vehicle_costs WHERE id = $1', [costId]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ===== Fotos próprias do lojista (substituem as da Dealers) =====
// Sobe uma foto pro vehicle_photos_custom. Múltiplas chamadas pra subir várias.
router.post('/stock-photo-upload', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { vehicleId, fileBase64, mime } = req.body;
    if (!vehicleId || !fileBase64 || !mime) {
      return res.status(400).json({ success: false, error: 'vehicleId, fileBase64 e mime são obrigatórios' });
    }
    const buf = Buffer.from(fileBase64, 'base64');
    if (buf.length > 6 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: 'Foto grande demais (máx 6MB cada)' });
    }
    // Próximo display_order = última posição + 1 (mantém ordem de upload)
    const order = await pool.query(
      'SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order FROM vehicle_photos_custom WHERE vehicle_id = $1',
      [parseInt(vehicleId)]
    );
    const r = await pool.query(
      `INSERT INTO vehicle_photos_custom (vehicle_id, data, mime, display_order)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [parseInt(vehicleId), buf, mime, order.rows[0].next_order]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    console.error('[stock-photo-upload] erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Apaga TODAS as fotos do veículo (custom + as da Dealers no photos/image).
// Usado quando o lojista quer começar do zero antes de subir as próprias.
router.post('/stock-photos-clear/:vehicleId', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const vId = parseInt(req.params.vehicleId);
    await pool.query('DELETE FROM vehicle_photos_custom WHERE vehicle_id = $1', [vId]);
    await pool.query("UPDATE purchases SET photos = NULL, image = NULL WHERE id = $1", [vId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/stock-photo/:id', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    await pool.query('DELETE FROM vehicle_photos_custom WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve uma foto custom (binário direto do banco). Mantém cache curto pro
// navegador não bater toda vez no servidor.
router.get('/stock-photo/:id', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const r = await pool.query(
      'SELECT data, mime FROM vehicle_photos_custom WHERE id = $1',
      [parseInt(req.params.id)]
    );
    if (r.rows.length === 0) return res.status(404).send('Foto não encontrada');
    res.setHeader('Content-Type', r.rows[0].mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(r.rows[0].data);
  } catch (err) {
    res.status(500).send('Erro: ' + err.message);
  }
});

// Sobe um anexo (PDF/imagem) UMA VEZ pra cost_attachments e devolve o id.
// Usado pelo modo lote da OCR: 1 PDF gera N custos, todos referenciando esse id.
router.post('/cost-attachment-upload', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { fileBase64, mime, name } = req.body;
    if (!fileBase64 || !mime) {
      return res.status(400).json({ success: false, error: 'fileBase64 e mime são obrigatórios' });
    }
    const buf = Buffer.from(fileBase64, 'base64');
    if (buf.length > 6 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: 'Arquivo grande demais (máx 6MB)' });
    }
    const r = await pool.query(
      `INSERT INTO cost_attachments (data, mime, name) VALUES ($1, $2, $3) RETURNING id`,
      [buf, mime, name || null]
    );
    res.json({ success: true, attachmentId: r.rows[0].id });
  } catch (err) {
    console.error('[cost-attachment-upload] erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Analisa um comprovante (PDF ou imagem) e devolve sugestão de categoria,
// valor e descrição. NÃO grava nada — só extrai pra pré-preencher o formulário.
// Body: { fileBase64, mime, name } (data sem o prefixo "data:...;base64,").
router.post('/stock-cost-parse', async (req, res) => {
  try {
    const { fileBase64, mime } = req.body;
    if (!fileBase64 || !mime) {
      return res.status(400).json({ success: false, error: 'fileBase64 e mime são obrigatórios' });
    }
    const buf = Buffer.from(fileBase64, 'base64');
    if (buf.length > 6 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: 'Arquivo grande demais (máx 6MB)' });
    }
    const { extractCostFromBuffer } = require('../services/costExtract');
    const result = await extractCostFromBuffer(buf, mime);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[stock-cost-parse] erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve um anexo de custo (PDF ou imagem). Resolve em ordem:
//   1. Se o custo tem attachment_id → busca em cost_attachments (compartilhado)
//   2. Senão, usa o attachment_data inline (legado, custo único)
router.get('/cost-attachment/:id', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const r = await pool.query(
      'SELECT attachment_data, attachment_type, attachment_name, attachment_id FROM vehicle_costs WHERE id = $1',
      [parseInt(req.params.id)]
    );
    if (r.rows.length === 0) return res.status(404).send('Custo não encontrado');
    const row = r.rows[0];
    let data = row.attachment_data, mime = row.attachment_type, name = row.attachment_name;
    if (row.attachment_id) {
      const a = await pool.query(
        'SELECT data, mime, name FROM cost_attachments WHERE id = $1',
        [row.attachment_id]
      );
      if (a.rows.length > 0) { data = a.rows[0].data; mime = a.rows[0].mime; name = a.rows[0].name; }
    }
    if (!data) return res.status(404).send('Anexo não encontrado');
    res.setHeader('Content-Type', mime || 'application/octet-stream');
    if (name) res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(name) + '"');
    res.send(data);
  } catch (err) {
    res.status(500).send('Erro: ' + err.message);
  }
});

// ===== Venda e Recebimentos =====
// Registra a venda de um veículo. A entrada (down_payment) entra como 1º
// recebimento; recebimentos parciais futuros são lançados em /stock-receipt.
router.post('/stock-sell', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { vehicleId, salePrice, soldDate, buyerName, buyerPhone, paymentMethod, downPayment, balanceDueDate, installments } = req.body;
    if (!vehicleId || !salePrice || parseFloat(salePrice) <= 0) {
      return res.status(400).json({ success: false, error: 'vehicleId e salePrice (>0) são obrigatórios' });
    }
    const vId = parseInt(vehicleId);
    const total = parseFloat(salePrice);
    const entry = parseFloat(downPayment) || 0;
    const date = soldDate || new Date().toISOString().split('T')[0];
    if (entry > total) {
      return res.status(400).json({ success: false, error: 'entrada não pode ser maior que o valor da venda' });
    }
    // Validacao das parcelas (quando informadas): soma deve casar com saldo (total - entrada),
    // com tolerancia de R$ 0,02 pra cobrir arredondamento na divisao.
    let parcelas = Array.isArray(installments) ? installments : [];
    if (parcelas.length > 0) {
      const soma = parcelas.reduce((acc, p) => acc + (parseFloat(p.amount) || 0), 0);
      const saldo = total - entry;
      if (Math.abs(soma - saldo) > 0.02) {
        return res.status(400).json({ success: false, error: `soma das parcelas (R$ ${soma.toFixed(2)}) nao bate com o saldo (R$ ${saldo.toFixed(2)})` });
      }
    }
    await pool.query(
      `UPDATE purchases SET sale_price = $1, sold_date = $2, buyer_name = $3, buyer_phone = $4,
       payment_method = $5, down_payment = $6, balance_due_date = $7, status = 'vendido'
       WHERE id = $8`,
      [total, date, buyerName || null, buyerPhone || null, paymentMethod || 'avista', entry, balanceDueDate || null, vId]
    );
    // Entrada vira o 1º recebimento (paid=true). Se à vista, é o valor total.
    if (entry > 0) {
      await pool.query(
        `INSERT INTO vehicle_receipts (vehicle_id, amount, received_date, notes, paid)
         VALUES ($1, $2, $3, $4, TRUE)`,
        [vId, entry, date, paymentMethod === 'avista' ? 'Pagamento à vista' : 'Entrada']
      );
    }
    // Parcelas agendadas: criadas com paid=FALSE. Quando o cliente pagar,
    // o admin clica em "marcar como recebida" e passa pra paid=TRUE.
    for (let i = 0; i < parcelas.length; i++) {
      const p = parcelas[i];
      const amt = parseFloat(p.amount) || 0;
      if (amt <= 0) continue;
      await pool.query(
        `INSERT INTO vehicle_receipts (vehicle_id, amount, received_date, notes, paid)
         VALUES ($1, $2, $3, $4, FALSE)`,
        [vId, amt, p.dueDate, `Parcela ${i + 1}/${parcelas.length}`]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[stock-sell] erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Marcar uma parcela agendada como recebida (paid=true). Opcionalmente atualiza
// a data efetiva (received_date) e adiciona observacao.
router.post('/stock-receipt/:id/pay', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { receivedDate, notes } = req.body || {};
    await pool.query(
      `UPDATE vehicle_receipts
       SET paid = TRUE,
           received_date = COALESCE($1, received_date),
           notes = COALESCE($2, notes)
       WHERE id = $3`,
      [receivedDate || null, notes || null, parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Desfaz uma venda (status volta pra 'disponivel' e zera os campos de venda +
// remove os recebimentos). Útil caso o usuário tenha registrado por engano.
router.post('/stock-unsell/:id', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const vId = parseInt(req.params.id);
    await pool.query('DELETE FROM vehicle_receipts WHERE vehicle_id = $1', [vId]);
    await pool.query(
      `UPDATE purchases SET sale_price = NULL, sold_date = NULL, buyer_name = NULL,
       buyer_phone = NULL, payment_method = NULL, down_payment = 0, balance_due_date = NULL,
       status = 'disponivel' WHERE id = $1`,
      [vId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Adiciona um recebimento parcial do saldo (pagamento da parcela).
router.post('/stock-receipt', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { vehicleId, amount, receivedDate, notes } = req.body;
    if (!vehicleId || !amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, error: 'vehicleId e amount (>0) são obrigatórios' });
    }
    const date = receivedDate || new Date().toISOString().split('T')[0];
    const result = await pool.query(
      `INSERT INTO vehicle_receipts (vehicle_id, amount, received_date, notes)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [parseInt(vehicleId), parseFloat(amount), date, notes || null]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/stock-receipt/:id', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    await pool.query('DELETE FROM vehicle_receipts WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Edita um recebimento existente. Útil quando o usuário lança valor errado e
// não quer apagar/recriar (perderia a ordem cronológica no histórico).
router.patch('/stock-receipt/:id', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { amount, receivedDate, notes } = req.body;
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, error: 'amount (>0) é obrigatório' });
    }
    await pool.query(
      `UPDATE vehicle_receipts SET amount = $1, received_date = $2, notes = $3
       WHERE id = $4`,
      [parseFloat(amount), receivedDate || new Date().toISOString().split('T')[0], notes || null, parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Agregados pra página Financeiro: receita realizada, lucro realizado, a receber.
router.get('/stock-finance', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    // Vendas (todas com sale_price preenchido)
    const sales = await pool.query(
      `SELECT id, brand, model, year, price, sale_price, sold_date, buyer_name,
              buyer_phone, balance_due_date,
              COALESCE((SELECT SUM(amount) FROM vehicle_costs WHERE vehicle_id = p.id), 0) AS total_costs,
              COALESCE((SELECT SUM(amount) FROM vehicle_receipts WHERE vehicle_id = p.id AND paid = TRUE), 0) AS total_received,
              COALESCE((SELECT SUM(amount) FROM vehicle_receipts WHERE vehicle_id = p.id AND paid = FALSE), 0) AS total_scheduled
         FROM purchases p
        WHERE sale_price IS NOT NULL
        ORDER BY sold_date DESC NULLS LAST, id DESC`
    );
    const today = new Date(); today.setHours(0,0,0,0);
    const todayIso = today.toISOString().split('T')[0];
    let revenue = 0, realizedProfit = 0, receivableOpen = 0, receivableOverdue = 0;
    const receivables = [];
    sales.rows.forEach(r => {
      const sp = parseFloat(r.sale_price) || 0;
      const cost = parseFloat(r.price) || 0;
      const costs = parseFloat(r.total_costs) || 0;
      const received = parseFloat(r.total_received) || 0;
      const remaining = Math.max(0, sp - received);
      revenue += sp;
      realizedProfit += (sp - cost - costs);
      if (remaining > 0) {
        receivableOpen += remaining;
        const due = r.balance_due_date;
        const isOverdue = due && new Date(due) < today;
        if (isOverdue) receivableOverdue += remaining;
        receivables.push({
          vehicleId: r.id,
          vehicle: `${r.brand} ${r.model}${r.year ? ' ' + r.year : ''}`,
          buyer: r.buyer_name,
          phone: r.buyer_phone,
          remaining,
          dueDate: due,
          overdue: !!isOverdue
        });
      }
    });
    res.json({
      success: true,
      data: {
        revenue,
        realizedProfit,
        receivableOpen,
        receivableOverdue,
        sales: sales.rows.length,
        receivables
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/stock-cost', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { vehicleId, category, description, amount, attachmentBase64, attachmentMime, attachmentName, attachmentId } = req.body;
    if (!vehicleId || !amount) {
      return res.status(400).json({ success: false, error: 'vehicleId e amount são obrigatórios' });
    }
    // Anexo: prefere REFERÊNCIA (attachmentId) sobre INLINE (base64). Cliente
    // que sobe 1 PDF pra N itens manda só o id — evita 5× a mesma base64.
    const refId = attachmentId ? parseInt(attachmentId) : null;
    const attachBuf = (!refId && attachmentBase64) ? Buffer.from(attachmentBase64, 'base64') : null;
    if (attachBuf && attachBuf.length > 6 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: 'Anexo grande demais (máx 6MB)' });
    }
    const result = await pool.query(
      `INSERT INTO vehicle_costs (vehicle_id, category, description, amount, cost_date, attachment_data, attachment_type, attachment_name, attachment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [parseInt(vehicleId), category || 'Outros', description || category || '', parseFloat(amount), new Date().toISOString().split('T')[0],
       attachBuf, attachBuf ? (attachmentMime || 'application/octet-stream') : null, attachBuf ? (attachmentName || null) : null, refId]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/my-purchases', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { brand, model, version, year, km, color, price, sell_price, status, notes } = req.body;
    const result = await pool.query(
      'INSERT INTO purchases (brand, model, version, year, km, color, price, sell_price, status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [brand, model, version, year, km || 0, color, price || 0, sell_price || 0, status || 'disponivel', notes]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/my-purchases/:id', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    await pool.query('DELETE FROM purchases WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === DEALERS ACCOUNTS ===
router.get('/dealers-accounts', requireAdmin, async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const result = await pool.query('SELECT id, name, email, shop_id, whitelabel_id, created_at FROM dealers_accounts ORDER BY id');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/dealers-accounts', requireAdmin, async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { name, email, password, shop_id, whitelabel_id } = req.body;
    if (!email || !password || !shop_id) {
      return res.status(400).json({ success: false, error: 'email, password e shop_id são obrigatórios' });
    }
    const result = await pool.query(
      'INSERT INTO dealers_accounts (name, email, password, shop_id, whitelabel_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, shop_id, whitelabel_id',
      [name || email, email, password, shop_id, whitelabel_id || '8']
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/dealers-accounts/:id', requireAdmin, async (req, res) => {
  try {
    const { pool } = require('../services/db');
    await pool.query('DELETE FROM dealers_accounts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Importação de um anúncio individual via URL/UUID — usa Puppeteer
router.post('/import-from-url', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Cole o link ou UUID do anúncio.' });

    const { scrapeAnuncio, extractUuidFromUrl } = require('../services/dealersScraper');
    const uuid = extractUuidFromUrl(url);
    if (!uuid) return res.status(400).json({ success: false, error: 'UUID inválido. Cole o link completo do anúncio Dealers.' });

    // Verificar se já existe no banco. Soft-delete (esconder) NAO remove a linha,
    // entao a checagem de duplicado batia mesmo depois do "Excluir" do admin.
    // Comportamento agora:
    //   - existe + visivel  -> bloqueia (anuncio ativo, evita duplicata)
    //   - existe + ESCONDIDO -> desesconde e refaz scrape pra atualizar dados (re-import efetivo)
    const dup = await pool.query(
      `SELECT p.id, p.brand, p.model, (h.vehicle_id IS NOT NULL) AS hidden
       FROM purchases p
       LEFT JOIN hidden_vehicles h ON h.vehicle_id = p.id
       WHERE p.dealers_uuid = $1`,
      [uuid]
    );
    if (dup.rows.length > 0) {
      const v = dup.rows[0];
      if (!v.hidden) {
        return res.json({ success: false, error: `Esse anúncio já está no estoque (id ${v.id}: ${v.brand} ${v.model}). Exclua antes se quiser reimportar.` });
      }
      // Marcar pra restaurar abaixo (depois do scrape) — assim os dados ficam atualizados.
      var restoreId = v.id;
    }

    // Pegar TODAS as contas Dealers — vamos tentar em sequência
    const accRes = await pool.query('SELECT name, email, password, whitelabel_id FROM dealers_accounts ORDER BY id');
    if (accRes.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Nenhuma conta Dealers cadastrada. Vá em Configurações.' });
    }

    let data = null;
    let lastError = null;
    let usedAccount = null;

    for (const acc of accRes.rows) {
      console.log(`[import-from-url] Tentando com conta "${acc.name}" (${acc.email})...`);
      try {
        const tentativa = await scrapeAnuncio(url, { email: acc.email, password: acc.password, whitelabel_id: acc.whitelabel_id });
        // Considera sucesso se conseguiu extrair pelo menos as fotos (anúncio acessível)
        if (tentativa && tentativa.fotos && tentativa.fotos.length > 0) {
          data = tentativa;
          usedAccount = acc.name;
          console.log(`[import-from-url] OK com conta "${acc.name}" - ${data.fotos.length} fotos, codigo=${data.codigo}`);
          break;
        } else {
          console.log(`[import-from-url] Conta "${acc.name}" sem acesso ao anúncio (0 fotos extraídas)`);
          lastError = `Conta "${acc.name}" sem acesso a esse anúncio`;
        }
      } catch (err) {
        console.log(`[import-from-url] Erro na conta "${acc.name}": ${err.message}`);
        lastError = err.message;
      }
    }

    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Anúncio não acessível em nenhuma conta cadastrada. Último erro: ' + (lastError || 'desconhecido')
      });
    }

    // Tentar buscar FIPE
    let fipePrice = 0;
    if (data.marca && data.modelo && data.ano) {
      const fipeResult = await fetchFipeValue(data.marca, data.modelo, data.versao || '', parseInt(String(data.ano).split('/')[0]));
      if (fipeResult) fipePrice = fipeResult.value;
    }

    // Extrair cidade da localização (formato esperado: "HUB Cidade/UF\n...")
    let city = '';
    if (data.localizacao) {
      const cityMatch = data.localizacao.match(/([A-Za-zÀ-ÿ\s]+)\/([A-Z]{2})/);
      if (cityMatch) city = cityMatch[1].trim() + '/' + cityMatch[2];
    }

    let v;
    if (typeof restoreId !== 'undefined') {
      // Restaurar: desesconde + atualiza com dados frescos do scrape
      await pool.query('DELETE FROM hidden_vehicles WHERE vehicle_id = $1', [restoreId]);
      const upd = await pool.query(`
        UPDATE purchases SET
          brand=$1, model=$2, version=$3, year=$4, km=$5, color=$6,
          fuel=$7, transmission=$8, city=$9, status='disponivel',
          notes=$10, price=$11, fipe_price=$12,
          image=$13, photos=$14, description=$15,
          dealers_code=$16, laudo=$17
        WHERE id=$18
        RETURNING id, brand, model, year
      `, [
        data.marca || '', data.modelo || '', data.versao || '',
        String(data.ano || ''), parseInt(data.km) || 0, data.cor || '',
        data.combustivel || '', data.cambio || '', city,
        `Restaurado via URL — ${new Date().toLocaleDateString('pt-BR')}`,
        parseFloat(data.valor) || 0, fipePrice,
        data.fotos[0] || null, JSON.stringify(data.fotos), data.descricao || '',
        data.codigo, data.laudo, restoreId
      ]);
      v = upd.rows[0];
    } else {
      const ins = await pool.query(`
        INSERT INTO purchases (
          brand, model, version, year, km, color,
          fuel, transmission, city, status, notes,
          price, fipe_price,
          image, photos, description,
          dealers_code, dealers_uuid, laudo,
          purchase_date
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,$11,
          $12,$13,
          $14,$15,$16,
          $17,$18,$19,
          $20
        ) RETURNING id, brand, model, year
      `, [
        data.marca || '',
        data.modelo || '',
        data.versao || '',
        String(data.ano || ''),
        parseInt(data.km) || 0,
        data.cor || '',
        data.combustivel || '',
        data.cambio || '',
        city,
        'disponivel',
        `Importado via URL — ${new Date().toLocaleDateString('pt-BR')}`,
        parseFloat(data.valor) || 0,
        fipePrice,
        data.fotos[0] || null,
        JSON.stringify(data.fotos),
        data.descricao || '',
        data.codigo,
        uuid,
        data.laudo,
        new Date().toISOString().split('T')[0]
      ]);
      v = ins.rows[0];
    }

    const verb = (typeof restoreId !== 'undefined') ? 'restaurado' : 'importado';
    res.json({
      success: true,
      id: v.id,
      message: `${v.brand} ${v.model} ${v.year} ${verb} com ${data.fotos.length} fotos (conta: ${usedAccount}).`,
      data: { ...data, dbId: v.id, usedAccount }
    });
  } catch (err) {
    console.error('[import-from-url] erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Re-puxa os laudos cautelares dos veículos do estoque que estão sem.
// Usa o scraper com cada conta Dealers cadastrada — quando encontra o veículo
// pelo UUID/código, atualiza o campo laudo no banco. Útil pra rodar UMA vez
// e preencher os carros antigos que foram importados antes do fix do scraper.
router.post('/stock-refresh-laudos', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { scrapeAnuncio } = require('../services/dealersScraper');
    // Busca só os que estão sem laudo E têm como identificar na origem (uuid ou code)
    const r = await pool.query(
      "SELECT id, dealers_uuid, dealers_code, brand, model FROM purchases WHERE (laudo IS NULL OR laudo = '') AND (dealers_uuid IS NOT NULL OR dealers_code IS NOT NULL)"
    );
    if (r.rows.length === 0) {
      return res.json({ success: true, message: 'Nenhum veículo precisa de laudo', updated: 0 });
    }
    const accRes = await pool.query('SELECT name, email, password, whitelabel_id FROM dealers_accounts ORDER BY id');
    if (accRes.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Nenhuma conta Dealers cadastrada' });
    }
    let updated = 0, failed = 0;
    const fails = [];
    for (const v of r.rows) {
      const uuid = v.dealers_uuid;
      if (!uuid) { failed++; continue; }
      // URL canônica do anúncio na Dealers — o scraper sabe extrair via UUID
      const url = 'https://vendadireta.dealersclub.com.br/anuncio/' + uuid;
      let laudo = null;
      for (const acc of accRes.rows) {
        try {
          const data = await scrapeAnuncio(url, { email: acc.email, password: acc.password, whitelabel_id: acc.whitelabel_id });
          if (data && data.laudo) { laudo = data.laudo; break; }
        } catch (_) { /* tenta próxima conta */ }
      }
      if (laudo) {
        await pool.query('UPDATE purchases SET laudo = $1 WHERE id = $2', [laudo, v.id]);
        updated++;
      } else {
        failed++;
        fails.push({ id: v.id, vehicle: v.brand + ' ' + v.model });
      }
    }
    res.json({ success: true, updated, failed, total: r.rows.length, fails });
  } catch (err) {
    console.error('[stock-refresh-laudos] erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sobe um PDF de laudo manualmente. Salva direto na linha do veículo em BYTEA.
// Usado quando o carro foi cadastrado sem laudo (importação antiga ou manual).
router.post('/stock-laudo-upload', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { vehicleId, fileBase64, mime, name } = req.body;
    if (!vehicleId || !fileBase64) {
      return res.status(400).json({ success: false, error: 'vehicleId e fileBase64 são obrigatórios' });
    }
    const buf = Buffer.from(fileBase64, 'base64');
    if (buf.length > 8 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: 'PDF grande demais (máx 8MB)' });
    }
    await pool.query(
      `UPDATE purchases SET laudo_data = $1, laudo_mime = $2, laudo_name = $3,
       laudo = $4 WHERE id = $5`,
      [buf, mime || 'application/pdf', name || null, '/api/stock-laudo/' + parseInt(vehicleId), parseInt(vehicleId)]
    );
    res.json({ success: true, url: '/api/stock-laudo/' + parseInt(vehicleId) });
  } catch (err) {
    console.error('[stock-laudo-upload] erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve o PDF do laudo armazenado no banco.
router.get('/stock-laudo/:id', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const r = await pool.query(
      'SELECT laudo_data, laudo_mime, laudo_name FROM purchases WHERE id = $1',
      [parseInt(req.params.id)]
    );
    if (r.rows.length === 0 || !r.rows[0].laudo_data) {
      return res.status(404).send('Laudo não encontrado');
    }
    res.setHeader('Content-Type', r.rows[0].laudo_mime || 'application/pdf');
    if (r.rows[0].laudo_name) {
      res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(r.rows[0].laudo_name) + '"');
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(r.rows[0].laudo_data);
  } catch (err) {
    res.status(500).send('Erro: ' + err.message);
  }
});

// Remove o laudo do veículo (manual e/ou URL).
router.delete('/stock-laudo/:id', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    await pool.query(
      'UPDATE purchases SET laudo_data = NULL, laudo_mime = NULL, laudo_name = NULL, laudo = NULL WHERE id = $1',
      [parseInt(req.params.id)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/import-purchases', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const accountsRes = await pool.query('SELECT * FROM dealers_accounts');
    const accounts = accountsRes.rows;

    if (accounts.length === 0) {
      return res.json({ success: false, error: 'Nenhuma conta Dealers cadastrada. Vá em Configurações e adicione.' });
    }

    let imported = 0;
    let errors = [];

    for (const account of accounts) {
      try {
        const purchases = await dealers.getMyPurchasesFromAccount(
          account.email, account.password, account.shop_id, account.whitelabel_id
        );

        if (!purchases || !Array.isArray(purchases.data || purchases)) continue;
        const items = purchases.data || purchases;

        for (const item of items) {
          const vehicle = item.vehicle || item;
          const brand = vehicle.brand_name || vehicle.brand || '';
          const model = vehicle.model_name || vehicle.model || '';
          const version = vehicle.version_name || vehicle.version || '';
          const year = vehicle.model_year || vehicle.year || '';
          const km = vehicle.km || 0;
          const color = vehicle.color || '';
          const price = item.offer_actual?.price || item.price || 0;
          const fuel = vehicle.fuel || '';
          const transmission = vehicle.transmission || '';
          const city = vehicle.city || '';
          const image = vehicle.image_gallery && vehicle.image_gallery.length > 0
            ? (vehicle.image_gallery[0].image || vehicle.image_gallery[0].thumb)
            : '';
          // Laudo cautelar: a Dealers manda em precautionary_report.file_url —
          // pode estar no item OU dentro de vehicle dependendo da resposta.
          const laudo = (item.precautionary_report && item.precautionary_report.file_url)
            || (vehicle.precautionary_report && vehicle.precautionary_report.file_url)
            || null;
          // Array de fotos (JSON) — galeria completa pro detalhe + carrossel
          let photosJson = null;
          if (vehicle.image_gallery && Array.isArray(vehicle.image_gallery)) {
            const urls = vehicle.image_gallery.map(g => g.image || g.thumb).filter(Boolean);
            if (urls.length) photosJson = JSON.stringify(urls);
          }
          // Descrição original (pra extração de localização/comitente e exibição)
          const description = vehicle.description || item.description || '';

          // Verificar se já existe (evitar duplicata)
          const exists = await pool.query(
            'SELECT id FROM purchases WHERE brand=$1 AND model=$2 AND year=$3 AND price=$4',
            [brand, model, String(year), price]
          );
          if (exists.rows.length > 0) {
            // Atualiza o laudo/photos/description caso a importação anterior nao tenha pego
            await pool.query(
              `UPDATE purchases SET
                laudo = COALESCE(laudo, $1),
                photos = COALESCE(photos, $2),
                description = COALESCE(NULLIF(description, ''), $3)
               WHERE id = $4`,
              [laudo, photosJson, description, exists.rows[0].id]
            );
            continue;
          }

          await pool.query(
            `INSERT INTO purchases (brand, model, version, year, km, color, price, status,
              notes, fuel, transmission, city, image, laudo, photos, description)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [brand, model, version, String(year), km, color, price, 'disponivel',
             'Importado de: ' + account.name, fuel, transmission, city, image,
             laudo, photosJson, description]
          );
          imported++;
        }
      } catch (err) {
        errors.push({ account: account.name, error: err.message });
      }
    }

    res.json({ success: true, imported, errors });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/my-offers', async (req, res) => {
  try {
    const data = await dealers.getMyOffers();
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/admin/bids', requireAdmin, async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const filter = req.query.outcome;
    let where = '';
    const params = [];
    if (filter === 'pendente') where = 'WHERE outcome IS NULL';
    else if (filter) { where = 'WHERE outcome = $1'; params.push(filter); }
    const sql = `SELECT b.*, p.id AS purchase_id
                 FROM bids b
                 LEFT JOIN purchases p ON p.bid_id = b.id
                 ${where}
                 ORDER BY b.created_at DESC LIMIT 200`;
    const result = await pool.query(sql, params);
    const bids = result.rows;

    // Enriquecer lances AINDA EM ANDAMENTO (outcome=null) com o status live
    // da Dealers — admin precisa ver "Levando" / "Coberto" durante o leilao,
    // nao so "Em andamento" generico. Lances ja resolvidos (venceu/perdeu)
    // mantem o status persistido — nao precisa bater na Dealers de novo.
    const ongoing = bids.filter(b => b.outcome === null || typeof b.outcome === 'undefined');
    const uniqueAds = [...new Set(ongoing.map(b => b.advertisement_id).filter(Boolean))];
    const offersByAd = new Map();
    await Promise.all(uniqueAds.map(async (adId) => {
      try {
        const offers = await dealers.getOffers(String(adId));
        if (Array.isArray(offers) && offers.length > 0) {
          const best = offers.reduce((mx, o) => {
            const v = parseFloat(o.price || o.value || 0);
            return v > parseFloat(mx.price || mx.value || 0) ? o : mx;
          }, offers[0]);
          offersByAd.set(adId, parseFloat(best.price || best.value || 0));
        }
      } catch (e) { /* deixa null — frontend mostra "Em andamento" */ }
    }));
    for (const b of bids) {
      if (b.outcome === null || typeof b.outcome === 'undefined') {
        const best = offersByAd.get(b.advertisement_id);
        if (best != null) {
          // CRITICO: bid_value tem a margem 5% incluida (valor que o cliente VIU).
          // O best vem da Dealers, SEM margem. Tem que comparar na mesma unidade
          // — usa removeSpread no bid_value. Sem isso, R$ 43.050 (com margem)
          // bate falsamente acima de R$ 42.000 (real), marcando "Levando" um
          // lance que FOI COBERTO. Bug pego em 17/06 com a Nathalia.
          const ourRealValue = removeSpread(parseFloat(b.bid_value) || 0);
          b.live_status = ourRealValue >= best ? 'levando' : 'coberto';
          b.live_best_value = best;
        }
      }
    }

    res.json({ success: true, data: bids });
  } catch (err) {
    res.json({ success: false, error: 'Erro ao buscar lances: ' + err.message });
  }
});

// Lances vencedores aguardando o admin conferir com a Dealers e aprovar.
// Esse e o painel principal pro dono pos-leilao.
router.get('/admin/bids/pending-approval', requireAdmin, async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const result = await pool.query(
      `SELECT b.*, p.id AS purchase_id, p.status AS purchase_status
       FROM bids b
       LEFT JOIN purchases p ON p.bid_id = b.id
       WHERE b.outcome = 'venceu' AND (b.admin_approved IS NULL OR b.admin_approved = FALSE)
       ORDER BY b.won_at DESC, b.created_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Admin aprova um lance vencedor (confere com a Dealers e libera).
// Marca admin_approved=true, opcional admin_notes, e promove o purchase
// de 'aguardando_aprovacao_admin' pra 'disponivel' (entra no estoque oficial).
router.post('/admin/bids/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const bidId = parseInt(req.params.id);
    const { notes } = req.body || {};
    const upd = await pool.query(
      `UPDATE bids SET admin_approved=TRUE, admin_approved_at=NOW(), admin_notes=$1
       WHERE id=$2 RETURNING *`,
      [notes || null, bidId]
    );
    if (upd.rows.length === 0) return res.status(404).json({ success: false, error: 'lance nao encontrado' });
    const bid = upd.rows[0];
    if (bid.outcome !== 'venceu') {
      return res.status(400).json({ success: false, error: 'so lances vencedores podem ser aprovados' });
    }
    await pool.query(
      `UPDATE purchases SET status='disponivel', notes=COALESCE(notes,'') || E'\\n[admin aprovou em ' || NOW()::date || ']'
       WHERE bid_id=$1 AND status='aguardando_aprovacao_admin'`,
      [bidId]
    );
    // Email pro cliente: "sua compra foi aprovada pelo admin". Async, nao bloqueia
    // a resposta. Idempotente — manda sempre que admin clicar Aprovar (se faz
    // sentido bloquear duplicado, ja temos admin_approved_at).
    notifyApproved(bid).catch(e => console.error('[approve] email falhou:', e.message));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Email pro cliente quando admin aprova o lance vencedor (confirmacao oficial).
async function notifyApproved(bid) {
  const { pool } = require('../services/db');
  const emailSvc = require('../services/email');
  if (!emailSvc.isEnabled()) return;
  if (!bid.user_id) return;
  const userRes = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [bid.user_id]);
  if (!userRes.rows.length || !userRes.rows[0].email) return;
  const user = userRes.rows[0];
  const PAY_KEYS = ['pay_razao_social', 'pay_cnpj', 'pay_banco', 'pay_agencia', 'pay_conta', 'pay_pix_key', 'pay_pix_tipo', 'pay_observacoes'];
  const payRes = await pool.query(`SELECT key, value FROM platform_settings WHERE key = ANY($1)`, [PAY_KEYS]);
  const payment = {};
  payRes.rows.forEach(r => { payment[r.key] = r.value || ''; });
  const vehicle = ((bid.vehicle_brand || '') + ' ' + (bid.vehicle_model || '')).trim() || 'Veículo';
  const final = parseFloat(bid.final_price || bid.bid_value) || 0;
  await emailSvc.sendEmail({
    to: user.email,
    subject: '✅ Compra aprovada — LancePrime',
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;line-height:1.6;color:#222;max-width:560px;margin:0 auto;padding:20px">
      <div style="background:linear-gradient(135deg,#00b894,#00a884);color:#fff;padding:24px;border-radius:10px 10px 0 0;text-align:center"><h1 style="margin:0;font-size:22px">✅ Compra aprovada!</h1></div>
      <div style="border:1px solid #ddd;border-top:none;padding:24px;border-radius:0 0 10px 10px">
        <p>Olá ${user.name || ''},</p>
        <p>Sua compra do <strong>${vehicle}</strong> no valor de <strong>${final.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</strong> foi <strong style="color:#00b894">aprovada pela nossa equipe</strong> após validação com a instituição vendedora.</p>
        <p>Se ainda não pagou o sinal de 10%, faça agora pra garantir o veículo:</p>
        <p><strong>Chave PIX:</strong> ${payment.pay_pix_key || '(consulte no painel)'}<br>
        <strong>${payment.pay_razao_social || 'Beneficiário'} — CNPJ/CPF:</strong> ${payment.pay_cnpj || ''}</p>
        ${payment.pay_observacoes ? `<p style="background:#eef;padding:10px;border-radius:6px;font-size:14px">${payment.pay_observacoes}</p>` : ''}
        <p style="text-align:center;margin:24px 0"><a href="https://lanceprimecars.com/#dashboard" style="background:#00b894;color:#fff;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block">Abrir Meu Painel</a></p>
        <p style="font-size:13px;color:#666">Em caso de dúvida, responda este email ou fale com a gente pelo WhatsApp.</p>
      </div>
    </body></html>`,
    text: `Sua compra do ${vehicle} (${final.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}) foi APROVADA. Pague o sinal de 10% via PIX: ${payment.pay_pix_key || ''}`
  });
}

// Admin rejeita um lance vencedor (ex: Dealers nao confirmou). Marca como
// 'rejeitado_admin' e EXCLUI a purchase auto-criada (idempotente).
router.post('/admin/bids/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const bidId = parseInt(req.params.id);
    const { notes } = req.body || {};
    await pool.query(
      `UPDATE bids SET admin_approved=FALSE, admin_approved_at=NOW(), admin_notes=$1, outcome='rejeitado_admin'
       WHERE id=$2`,
      [notes || null, bidId]
    );
    await pool.query(`DELETE FROM purchases WHERE bid_id=$1 AND status='aguardando_aprovacao_admin'`, [bidId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trigger manual da reconciliacao (admin pode forcar agora em vez de esperar
// o cron de 15min). Util quando um leilao acabou de fechar.
router.post('/admin/reconcile-bids', requireAdmin, async (req, res) => {
  try {
    const { reconcileOnce } = require('../services/bidReconciliation');
    const summary = await reconcileOnce();
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === TESTE: simula vitoria pra um cliente especifico ===
// Admin usa pra validar o fluxo end-to-end (email + banner + FAB + QR) sem
// depender de leilao real e sem afetar nada de producao. Cria um bid fake
// ja marcado como outcome=venceu, dispara email, e o cliente vê tudo na hora.
router.post('/admin/test/simulate-win', requireAdmin, async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { client_email, bid_value, vehicle_brand, vehicle_model } = req.body || {};
    if (!client_email) return res.status(400).json({ success: false, error: 'client_email obrigatorio' });
    const value = parseFloat(bid_value) || 50000;
    const userRes = await pool.query('SELECT id, name, email FROM users WHERE email = $1', [client_email]);
    if (!userRes.rows.length) return res.status(404).json({ success: false, error: 'cliente nao encontrado com esse email' });
    const user = userRes.rows[0];

    const brand = vehicle_brand || 'Volkswagen';
    const model = vehicle_model || 'Jetta TESTE';
    // Anuncio fake com ID alto pra nao colidir com nada real (negativo evita
    // confusao com IDs reais positivos da Dealers).
    const fakeAdId = -Math.floor(Math.random() * 1000000) - 1;
    const now = new Date();
    const deadline = new Date(now.getTime() + 5 * 60 * 1000);
    const snapshot = JSON.stringify({
      brand, model, version: 'Comfortline TSI',
      year_manufacture: 2023, year_model: 2024,
      km: 25000, color: 'PRATA', plate: 'TEST1234',
      location: 'BETIM/MG', uf: 'MG', initial_price: value * 0.9,
    });

    const ins = await pool.query(
      `INSERT INTO bids (user_id, user_name, user_email, advertisement_id,
                         vehicle_brand, vehicle_model, bid_value, bid_type,
                         auction_end_date, outcome, final_price, won_at,
                         reconciled_at, payment_deadline, vehicle_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,'venceu',$9,$10,$10,$11,$12)
       RETURNING id`,
      [user.id, user.name, user.email, fakeAdId,
       brand, model, value, now, value, now, deadline, snapshot]
    );
    const bidId = ins.rows[0].id;

    // Cria purchase ligada (igual flow real)
    await pool.query(
      `INSERT INTO purchases (brand, model, version, year, km, color, status,
                              notes, price, fipe_price, bid_id, purchase_date)
       VALUES ($1,$2,'Comfortline TSI','2023/2024',25000,'PRATA',
               'aguardando_aprovacao_admin','[TESTE] Vitoria simulada via admin',
               $3, 0, $4, $5)`,
      [brand, model, value, bidId, now.toISOString().split('T')[0]]
    );

    // Dispara email vencedor (assincrono — nao bloqueia resposta)
    const emailSvc = require('../services/email');
    if (emailSvc.isEnabled()) {
      const PAY_KEYS = ['pay_razao_social', 'pay_cnpj', 'pay_banco', 'pay_agencia', 'pay_conta', 'pay_pix_key', 'pay_pix_tipo', 'pay_observacoes'];
      const payRes = await pool.query(`SELECT key, value FROM platform_settings WHERE key = ANY($1)`, [PAY_KEYS]);
      const payment = {};
      payRes.rows.forEach(r => { payment[r.key] = r.value || ''; });
      const fakeBid = { id: bidId, vehicle_brand: brand, vehicle_model: model,
                        bid_value: value, final_price: value, payment_deadline: deadline };
      emailSvc.sendWinnerEmail(fakeBid, user, payment)
        .then(r => { if (!r.skipped) pool.query('UPDATE bids SET notified_winner_at=NOW() WHERE id=$1', [bidId]).catch(()=>{}); })
        .catch(e => console.error('[test simulate-win] email falhou:', e.message));
    }

    res.json({
      success: true,
      message: 'Vitoria simulada criada. Faca login como ' + user.email + ' pra ver o banner/QR/FAB. Email enviado tambem (se Resend estiver configurado).',
      bid_id: bidId,
      user: { id: user.id, name: user.name, email: user.email },
      bid_value: value,
      sinal_10pct: +(value * 0.10).toFixed(2),
      payment_deadline: deadline.toISOString(),
    });
  } catch (err) {
    console.error('[simulate-win] erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Apaga TODAS as vitorias simuladas (advertisement_id < 0 = nossos fake).
// Usado pra limpar tudo depois do teste.
router.post('/admin/test/clear-simulations', requireAdmin, async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const purgePurchases = await pool.query(
      `DELETE FROM purchases WHERE bid_id IN (SELECT id FROM bids WHERE advertisement_id < 0) RETURNING id`
    );
    const purgeBids = await pool.query(
      'DELETE FROM bids WHERE advertisement_id < 0 RETURNING id'
    );
    res.json({ success: true, bids_removed: purgeBids.rows.length, purchases_removed: purgePurchases.rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/admin/reconcile-status', requireAdmin, (req, res) => {
  const { getStatus } = require('../services/bidReconciliation');
  res.json({ success: true, ...getStatus() });
});

// Status da config de email — frontend usa pra mostrar "Configurado" / "Faltando RESEND_API_KEY"
router.get('/admin/email/status', requireAdmin, (req, res) => {
  const email = require('../services/email');
  res.json({
    success: true,
    configured: email.isEnabled(),
    from: process.env.EMAIL_FROM || 'LancePrime <onboarding@resend.dev>'
  });
});

// Envia email de TESTE pro endereco informado — admin usa pra validar
// que RESEND_API_KEY funciona antes de depender dele em producao.
router.post('/admin/email/test', requireAdmin, async (req, res) => {
  try {
    const email = require('../services/email');
    const to = (req.body && req.body.to) ? String(req.body.to).trim() : null;
    if (!to || !/^.+@.+\..+$/.test(to)) {
      return res.status(400).json({ success: false, error: 'informe um email valido em "to"' });
    }
    if (!email.isEnabled()) {
      return res.status(503).json({ success: false, error: 'RESEND_API_KEY nao configurada no servidor' });
    }
    const r = await email.sendEmail({
      to,
      subject: '✅ Teste LancePrime — email funcionando',
      html: '<p>Se você está lendo isto, o envio de email do LancePrime está OK.</p><p>Data/hora: ' + new Date().toLocaleString('pt-BR') + '</p>',
      text: 'Teste OK — ' + new Date().toLocaleString('pt-BR')
    });
    res.json({ success: true, result: r });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== Dados de pagamento da plataforma (CNPJ/PIX/banco do dono) =====
// Solucao TEMPORARIA enquanto a integracao de gateway de pagamento nao entra.
// O cliente vencedor (com lance outcome='venceu') consulta esses dados pra
// fazer PIX/TED manual do sinal. Admin edita pela aba Configuracoes.
const PAY_KEYS = ['pay_razao_social', 'pay_cnpj', 'pay_banco', 'pay_agencia', 'pay_conta', 'pay_pix_key', 'pay_pix_tipo', 'pay_observacoes'];

router.get('/admin/platform-settings', requireAdmin, async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const r = await pool.query(`SELECT key, value FROM platform_settings WHERE key = ANY($1)`, [PAY_KEYS]);
    const out = {};
    PAY_KEYS.forEach(k => out[k] = '');
    r.rows.forEach(row => { out[row.key] = row.value || ''; });
    res.json({ success: true, settings: out });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/admin/platform-settings', requireAdmin, async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const body = req.body || {};
    for (const k of PAY_KEYS) {
      if (k in body) {
        await pool.query(
          `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [k, String(body[k] || '')]
        );
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Gera o BR Code PIX (copia/cola) pro lance vencedor do cliente. Calcula o
// valor do sinal (10%) automaticamente e usa os dados de pagamento do
// platform_settings. SO retorna se o bid pertence ao usuario logado e ja
// foi marcado como venceu. Frontend usa essa string pra renderizar o QR.
router.get('/me/pix-qr/:bidId', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { brCode } = require('../services/pixQr');
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ success: false, error: 'Faça login' });
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(auth.replace('Bearer ', ''), process.env.JWT_SECRET);
    const bidId = parseInt(req.params.bidId);
    if (!bidId) return res.status(400).json({ success: false, error: 'bidId invalido' });

    // Busca o lance — confere que e do usuario E que venceu
    const bidRes = await pool.query(
      'SELECT id, user_id, advertisement_id, vehicle_brand, vehicle_model, bid_value, final_price, outcome FROM bids WHERE id = $1',
      [bidId]
    );
    if (!bidRes.rows.length) return res.status(404).json({ success: false, error: 'Lance nao encontrado' });
    const bid = bidRes.rows[0];
    if (decoded.role !== 'admin' && bid.user_id !== decoded.id) {
      return res.status(403).json({ success: false, error: 'Lance nao pertence a voce' });
    }
    if (bid.outcome !== 'venceu') {
      return res.status(400).json({ success: false, error: 'Lance ainda nao foi marcado como vencedor' });
    }

    // Dados de pagamento do dono
    const PAY_KEYS = ['pay_razao_social', 'pay_cnpj', 'pay_pix_key', 'pay_pix_tipo'];
    const payRes = await pool.query(`SELECT key, value FROM platform_settings WHERE key = ANY($1)`, [PAY_KEYS]);
    const p = {};
    payRes.rows.forEach(r => { p[r.key] = r.value || ''; });
    if (!p.pay_pix_key) {
      return res.status(503).json({ success: false, error: 'Chave PIX nao configurada no admin ainda' });
    }

    // CRITICO: usa bid_value (valor que o cliente VIU e ofertou, com a margem
    // de 5% ja incluida) — NAO final_price (valor cru da Dealers, sem margem).
    // O sinal de 10% e cobrado sobre o que o cliente acordou pagar, nao sobre
    // o valor que a gente repassa pra Dealers.
    const customerPrice = parseFloat(bid.bid_value || bid.final_price) || 0;
    const sinal = +(customerPrice * 0.10).toFixed(2);
    const txid = ('LP' + bid.id).slice(0, 25);
    const code = brCode({
      pixKey: p.pay_pix_key,
      name: p.pay_razao_social || 'LancePrime',
      city: process.env.PIX_CITY || 'BETIM',
      amount: sinal,
      txid: txid,
    });

    res.json({
      success: true,
      brcode: code,           // string "copia e cola"
      amount: sinal,
      vehicle: ((bid.vehicle_brand||'') + ' ' + (bid.vehicle_model||'')).trim(),
      beneficiary: p.pay_razao_social || '',
      cnpj: p.pay_cnpj || '',
      pix_key: p.pay_pix_key,
      pix_tipo: p.pay_pix_tipo || '',
      txid: txid,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cliente le os dados de pagamento. SO retorna se tiver pelo menos 1 lance
// com outcome='venceu' — evita expor dados bancarios do dono pra quem nunca
// ofertou. Admin sempre ve.
router.get('/me/payment-info', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ success: false, error: 'Faça login' });
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(auth.replace('Bearer ', ''), process.env.JWT_SECRET);

    if (decoded.role !== 'admin') {
      const w = await pool.query(
        "SELECT 1 FROM bids WHERE user_id = $1 AND outcome = 'venceu' LIMIT 1",
        [decoded.id]
      );
      if (w.rows.length === 0) {
        return res.status(403).json({ success: false, error: 'Sem lances vencedores no momento.' });
      }
    }
    const r = await pool.query(`SELECT key, value FROM platform_settings WHERE key = ANY($1)`, [PAY_KEYS]);
    const out = {};
    PAY_KEYS.forEach(k => out[k] = '');
    r.rows.forEach(row => { out[row.key] = row.value || ''; });
    res.json({ success: true, payment: out });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

router.get('/admin/user/:id/profile', requireAdmin, async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const userId = parseInt(req.params.id);
    if (isNaN(userId)) return res.json({ success: false, error: 'ID inválido' });
    const userRes = await pool.query('SELECT id, name, email, phone, cpf, approved, created_at, birth_date, person_type, cnpj, company_name, cep, street, number, complement, neighborhood, city, uf FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return res.json({ success: false, error: 'Usuário não encontrado' });
    const bidsRes = await pool.query('SELECT * FROM bids WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    const docsRes = await pool.query('SELECT id, doc_type, filename, mime, verified, verified_at, verified_by, rejected_reason, created_at FROM user_documents WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    res.json({ success: true, data: { user: userRes.rows[0], bids: bidsRes.rows, documents: docsRes.rows } });
  } catch (err) {
    res.json({ success: false, error: 'Erro ao buscar perfil' });
  }
});

router.get('/my-bids', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.json({ success: true, data: [] });
    if (!process.env.JWT_SECRET) return res.json({ success: true, data: [] });
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const bidsRes = await pool.query(
      `SELECT b.*, p.id AS purchase_id, p.status AS purchase_status
       FROM bids b
       LEFT JOIN purchases p ON p.bid_id = b.id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC`,
      [decoded.id]
    );

    // Status computado: prefere o outcome PERSISTIDO. Pra lances ainda
    // pendentes (outcome=null), olha live na Dealers como antes. Vantagens:
    // 1) lances ja resolvidos nao dependem mais da Dealers ficar online;
    // 2) ganhei/perdi pos-leilao fica SALVO, nao depende de re-checar.
    const out = [];
    const checkedAds = new Map();
    for (const b of bidsRes.rows) {
      let status;
      if (b.outcome === 'venceu') {
        status = b.admin_approved === true ? 'aprovado' : 'venceu_aguardando';
      } else if (b.outcome === 'perdeu') {
        status = 'perdeu';
      } else if (b.outcome === 'rejeitado_admin') {
        status = 'rejeitado';
      } else {
        // Ainda nao reconciliado — checa live se possivel
        status = 'pendente';
        try {
          if (!checkedAds.has(b.advertisement_id)) {
            const offers = await dealers.getOffers(String(b.advertisement_id));
            checkedAds.set(b.advertisement_id, offers);
          }
          const offers = checkedAds.get(b.advertisement_id);
          if (offers && offers.length > 0) {
            const bestOffer = offers.reduce((max, o) => (parseFloat(o.price || o.value || 0) > parseFloat(max.price || max.value || 0)) ? o : max, offers[0]);
            const bestValue = parseFloat(bestOffer.price || bestOffer.value || 0);
            // CRITICO: bid_value tem margem 5% (cliente ve), bestValue vem da
            // Dealers sem margem. Tem que comparar na mesma unidade.
            const ourRealValue = removeSpread(parseFloat(b.bid_value) || 0);
            status = ourRealValue >= bestValue ? 'levando' : 'coberto';
          }
        } catch (e) { /* mantem pendente */ }
      }
      out.push({ ...b, status });
    }
    res.json({ success: true, data: out });
  } catch (err) {
    res.json({ success: true, data: [], error: err.message });
  }
});

router.get('/server-time', (req, res) => {
  res.json({ time: Date.now() });
});

// === FIPE via Parallelum (gratuito, sem token) ===
// Lista versões FIPE pra um modelo+ano. Usado pelo modal "Atualizar FIPE".
const PARALLELUM = 'https://parallelum.com.br/fipe/api/v1/carros';

function parallelumNormalize(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// GET com retry no 429 (rate limit da Parallelum) + cache em memória com TTL.
// /marcas e /modelos por marca quase nunca mudam — cacheamos por 12h pra
// reduzir drasticamente o número de chamadas. Retry com backoff exponencial
// + jitter trata 429/503/timeout sem hammering.
const parallelumCache = new Map();
const PARALLELUM_TTL = 12 * 60 * 60 * 1000;

async function parallelumGet(url) {
  const cached = parallelumCache.get(url);
  if (cached && Date.now() - cached.ts < PARALLELUM_TTL) return cached.res;
  if (cached) parallelumCache.delete(url);

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await axios.get(url, { timeout: 7000 });
      parallelumCache.set(url, { ts: Date.now(), res });
      return res;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status === 429 || status === 503 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
        await new Promise(r => setTimeout(r, 600 + Math.floor(Math.random() * 400)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Roda fn(item) em todos os items com no máximo `concurrency` em paralelo.
// Evita estourar rate limit da Parallelum (que aceita ~30-60 req/min).
async function runPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = { status: 'fulfilled', value: await fn(items[i]) }; }
      catch (err) { results[i] = { status: 'rejected', reason: err }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// Cache persistente (DB) da lista de versões já montada, por busca.
// TTL de 7 dias: a tabela FIPE muda ~1x/mês, então 7 dias é seguro e
// economiza a maioria das chamadas à Parallelum.
const FIPE_VERSIONS_TTL_DAYS = 7;

async function getVersionsCache(cacheKey) {
  try {
    const r = await pool.query(
      'SELECT data, updated_at FROM fipe_versions_cache WHERE cache_key = $1',
      [cacheKey]
    );
    if (r.rows.length === 0) return null;
    const ageMs = Date.now() - new Date(r.rows[0].updated_at).getTime();
    return { data: r.rows[0].data, fresh: ageMs < FIPE_VERSIONS_TTL_DAYS * 86400000 };
  } catch (err) {
    console.log('[fipe/versions] erro lendo cache DB:', err.message);
    return null;
  }
}

async function setVersionsCache(cacheKey, data) {
  try {
    await pool.query(
      `INSERT INTO fipe_versions_cache (cache_key, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (cache_key) DO UPDATE SET data = $2, updated_at = NOW()`,
      [cacheKey, JSON.stringify(data)]
    );
  } catch (err) {
    console.log('[fipe/versions] erro salvando cache DB:', err.message);
  }
}

// Quantos modelos processar por busca. Cada modelo ranqueado = uma chamada de
// /anos à FIPE, então isso é o que mais consome a cota (free = 1.000/dia).
// Ranqueamos por SIMILARIDADE com a versão do veículo e pegamos só os 10 mais
// parecidos — a versão certa (+ alternativas próximas) entra, e gasta ~10x
// menos cota que listar tudo. Resultado fica em cache no banco por 7 dias.
const FIPE_MAX_MODELS = 6;

// Ordena modelos por similaridade com "modelo + versão" e devolve os melhores.
function rankModels(models, getName, model, version, limit = FIPE_MAX_MODELS) {
  const searchStr = `${model} ${version || ''}`.trim();
  return models
    .map(m => ({ m, score: similarity(getName(m), searchStr) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.m);
}

// Caminho primário: fipe.online (autenticada por token, 1000 req/dia).
// Bem mais confiável que a Parallelum pública — é a mesma API usada no
// resto do sistema (fetchFipeValue). Tenta carros e depois motos.
// Empurra cada versão encontrada em `out` assim que resolve, pra que um
// corte por tempo (na rota) ainda devolva resultado parcial.
async function buildVersionsFipeOnline(brand, model, years, version, out) {
  const brandNorm = normalize(brand);
  const modelNorm = normalize(model);

  for (const cat of ['cars', 'motorcycles']) {
    const brands = await fipeGet(`/${cat}/brands`);
    const marca = brands.find(b => normalize(b.name) === brandNorm)
      || brands.find(b => normalize(b.name).includes(brandNorm) || brandNorm.includes(normalize(b.name)));
    if (!marca) continue;

    const models = await fipeGet(`/${cat}/brands/${marca.code}/models`);
    const filtered = models.filter(m => normalize(m.name).includes(modelNorm));
    const matching = rankModels(filtered, m => m.name, model, version);
    if (matching.length === 0) continue;

    const yearsResults = await runPool(matching, 2, async (m) => {
      const yrs = await fipeGet(`/${cat}/brands/${marca.code}/models/${m.code}/years`);
      return { m, years: yrs };
    });

    const targets = [];
    for (const r of yearsResults) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const { m, years: yrs } = r.value;
      for (const y of yrs) {
        const yearOnly = parseInt(String(y.code).split('-')[0]);
        if (years.length && !years.includes(yearOnly)) continue;
        targets.push({ m, y });
      }
    }

    await runPool(targets, 2, async (t) => {
      const d = await fipeGet(`/${cat}/brands/${marca.code}/models/${t.m.code}/years/${t.y.code}`);
      out.push({
        fipeCode: d.codeFipe,
        modelName: d.model,
        year: d.modelYear,
        fuel: d.fuel || '',
        value: parseFloat(String(d.price).replace('R$ ', '').replace(/\./g, '').replace(',', '.')),
        reference: d.referenceMonth,
        brandCode: marca.code,
        modelCode: t.m.code,
        yearCode: t.y.code
      });
    });

    if (out.length > 0) return;
  }
}

// Fallback: Parallelum pública (sem token, mas rate-limited). Só é usada
// quando a fipe.online não retorna nada (ex.: token ausente/expirado).
async function buildVersionsParallelum(brand, model, years, version, out) {
  const brandsRes = await parallelumGet(PARALLELUM + '/marcas');
  const brandNorm = parallelumNormalize(brand);
  const marca = brandsRes.data.find(b => parallelumNormalize(b.nome) === brandNorm)
    || brandsRes.data.find(b => parallelumNormalize(b.nome).includes(brandNorm) || brandNorm.includes(parallelumNormalize(b.nome)));
  if (!marca) return;

  const modelsRes = await parallelumGet(PARALLELUM + '/marcas/' + marca.codigo + '/modelos');
  const modelNorm = parallelumNormalize(model);
  const filtered = modelsRes.data.modelos.filter(m => parallelumNormalize(m.nome).includes(modelNorm));
  // Parallelum (pública) limita o IP por taxa: processa menos modelos (top 12
  // ranqueados — já inclui a versão certa) com baixa concorrência, pra evitar
  // o burst que dispara o 429.
  const matchingModels = rankModels(filtered, m => m.nome, model, version, FIPE_MAX_MODELS);
  if (matchingModels.length === 0) return;

  const yearsResults = await runPool(matchingModels, 2, async (m) => {
    const r = await parallelumGet(PARALLELUM + '/marcas/' + marca.codigo + '/modelos/' + m.codigo + '/anos');
    return { model: m, years: r.data };
  });

  const versions = [];
  for (const r of yearsResults) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const { model: mm, years: yrs } = r.value;
    for (const y of yrs) {
      const yearOnly = parseInt(y.codigo.split('-')[0]);
      if (years.length && !years.includes(yearOnly)) continue;
      versions.push({ brandCode: marca.codigo, modelCode: mm.codigo, yearCode: y.codigo, modelName: mm.nome });
    }
  }

  await runPool(versions, 2, async (v) => {
    const r = await parallelumGet(`${PARALLELUM}/marcas/${v.brandCode}/modelos/${v.modelCode}/anos/${v.yearCode}`);
    const d = r.data;
    out.push({
      fipeCode: d.CodigoFipe,
      modelName: d.Modelo,
      year: d.AnoModelo,
      fuel: d.Combustivel,
      value: parseFloat(String(d.Valor).replace('R$ ', '').replace(/\./g, '').replace(',', '.')),
      reference: d.MesReferencia,
      brandCode: v.brandCode,
      modelCode: v.modelCode,
      yearCode: v.yearCode
    });
  });
}

// Orçamento de resposta: a rota SEMPRE responde dentro desse tempo, mesmo se
// a FIPE estiver lenta — devolvendo resultado parcial. Sem isso o gateway
// derruba a conexão e o app recebe HTML 502 (o erro que o usuário via).
const FIPE_BUDGET_MS = parseInt(process.env.FIPE_BUDGET_MS) || 12000;

router.get('/fipe/versions', async (req, res) => {
  const { brand, model, year, version } = req.query;
  if (!brand || !model) {
    return res.status(400).json({ success: false, error: 'brand e model são obrigatórios' });
  }
  // Namespace versionado + versão na chave. Bump pra v4: passamos a usar o ano
  // MODELO (maior), então caches antigos (ano fabricação) precisam ser refeitos.
  const cacheKey = `v5|${brand}|${model}|${year || ''}|${version || ''}`.toLowerCase().trim();

  // 0. Cache fresco no DB → resposta instantânea, zero chamadas externas.
  const cached = await getVersionsCache(cacheKey);
  if (cached && cached.fresh && cached.data.length > 0) {
    return res.json({ success: true, data: cached.data, count: cached.data.length, cached: true });
  }

  // "2014/2015" = ano fabricação/modelo. Numa passada só, aceitamos versões de
  // qualquer um dos anos do par e, no fim, ficamos com o ANO MODELO (o maior
  // presente): HB20 -> 2015; Fox -> 2022 se houver, senão 2021. Passada única
  // = metade das chamadas (não dobra), pra não estourar limite por IP.
  const yearList = [...new Set(String(year || '').split('/').map(p => parseInt(p)).filter(Boolean))];
  const out = [];
  const state = { done: false };

  // Roda em paralelo ao timer; empurra versões em `out` conforme resolve.
  const work = (async () => {
    // Sem token, a fipe.online responde 429 em tudo ("obtenha um token") e só
    // desperdiça o orçamento — então nem tenta, vai direto pra Parallelum.
    if (FIPE_TOKEN) {
      try {
        await buildVersionsFipeOnline(brand, model, yearList, version, out);
      } catch (e) {
        console.error('[fipe/versions] fipe.online:', e.message);
      }
    }
    if (out.length === 0) {
      try {
        await buildVersionsParallelum(brand, model, yearList, version, out);
      } catch (e) {
        console.error('[fipe/versions] parallelum:', e.message);
      }
    }
    state.done = true;
  })();

  await Promise.race([work, new Promise(r => setTimeout(r, FIPE_BUDGET_MS))]);

  // Dedup + fica só com o ano-modelo mais alto presente + ordena por valor.
  const seen = new Set();
  let detailed = out.filter(v => {
    const k = `${v.fipeCode}|${v.year}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (detailed.length > 0) {
    const maxYear = Math.max(...detailed.map(v => Number(v.year) || 0));
    detailed = detailed.filter(v => (Number(v.year) || 0) === maxYear);
  }
  detailed.sort((a, b) => b.value - a.value);

  if (detailed.length > 0) {
    // Só cacheia resultado COMPLETO — parcial não vira cache "fresco".
    if (state.done) await setVersionsCache(cacheKey, detailed);
    return res.json({ success: true, data: detailed, count: detailed.length, partial: !state.done });
  }

  // Nada ao vivo: serve cache antigo se houver.
  if (cached && cached.data.length > 0) {
    return res.json({ success: true, data: cached.data, count: cached.data.length, cached: true, stale: true });
  }
  if (!state.done) {
    return res.json({ success: false, data: [], error: 'A FIPE está lenta agora. Tente novamente em instantes.' });
  }
  return res.json({ success: false, data: [], error: 'Nenhuma versão encontrada para ' + brand + ' ' + model });
});

// Atualiza FIPE de um veículo no estoque escolhendo um fipeCode específico.
router.post('/stock-fipe-update', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { vehicleId, fipePrice, fipeCode, modelName, reference, year, brandCode, modelCode, yearCode } = req.body;
    if (!vehicleId) {
      return res.status(400).json({ success: false, error: 'vehicleId obrigatório' });
    }

    // A versão escolhida no modal já traz o valor (vindo de /fipe/versions, que
    // é cacheado). Salvamos direto, sem nova consulta à Parallelum — isso
    // elimina um 429 inteiro no momento de aplicar. Só busca ao vivo se o
    // valor não veio (compatibilidade), usando os códigos da versão.
    let value = parseFloat(fipePrice);
    let detail = { Modelo: modelName, CodigoFipe: fipeCode, MesReferencia: reference, AnoModelo: year };

    if (!value || isNaN(value)) {
      if (!brandCode || !modelCode || !yearCode) {
        return res.status(400).json({ success: false, error: 'fipePrice ou (brandCode, modelCode, yearCode) obrigatórios' });
      }
      const r = await parallelumGet(`${PARALLELUM}/marcas/${brandCode}/modelos/${modelCode}/anos/${yearCode}`);
      detail = r.data;
      value = parseFloat(String(detail.Valor).replace('R$ ', '').replace(/\./g, '').replace(',', '.'));
    }

    await pool.query(
      'UPDATE purchases SET fipe_price = $1 WHERE id = $2',
      [value, parseInt(vehicleId)]
    );

    res.json({
      success: true,
      data: {
        fipePrice: value,
        modelName: detail.Modelo,
        fipeCode: detail.CodigoFipe,
        reference: detail.MesReferencia,
        year: detail.AnoModelo
      }
    });
  } catch (err) {
    console.error('[stock-fipe-update] erro:', err.message);
    const status = err.response?.status;
    const userMsg = status === 429
      ? 'FIPE com muitas consultas. Tente novamente em alguns segundos.'
      : err.message;
    res.status(status === 429 ? 429 : 500).json({ success: false, error: userMsg, rateLimited: status === 429 });
  }
});

router.get('/fipe/valor', async (req, res) => {
  try {
    const { brand, model, version, year } = req.query;
    if (!brand || !model || !year) {
      return res.status(400).json({ success: false, error: 'brand, model e year são obrigatórios' });
    }
    const result = await fetchFipeValue(brand, model, version || '', parseInt(year));
    if (result) {
      res.json({ success: true, data: result });
    } else {
      res.json({ success: false, data: null, debug: 'fetchFipeValue returned null' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
});

// Salva uma escolha MANUAL de FIPE pra um carro do catálogo, sobrescrevendo
// o match automático na fipe_cache. Usado pelo modal "Corrigir FIPE" do
// detalhe do veículo — quando o lojista vê que o auto-match pegou a versão
// errada (Highline virou Comfortline, ou Hilux Auto virou Manual), ele abre
// o modal, escolhe a versão certa, e a partir daí TODO MUNDO vê o FIPE
// correto naquele card. Restrito ao admin pra evitar sabotagem.
router.post('/fipe/override', requireAdmin, async (req, res) => {
  try {
    const { brand, model, version, year, fipeValue, fipeModel, fipeCode, reference } = req.body;
    if (!brand || !model || !year || !fipeValue) {
      return res.status(400).json({ success: false, error: 'brand, model, year e fipeValue são obrigatórios' });
    }
    const cacheKey = `${brand}|${model}|${version || ''}|${year}`.toLowerCase();
    await pool.query(
      `INSERT INTO fipe_cache (cache_key, brand, model, version, year, fipe_value, fipe_model, fipe_code, fipe_reference, match_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1.00)
       ON CONFLICT (cache_key) DO UPDATE SET
         fipe_value = $6, fipe_model = $7, fipe_code = $8, fipe_reference = $9, match_score = 1.00, updated_at = NOW()`,
      [cacheKey, brand, model, version || '', parseInt(year), fipeValue, fipeModel || '', fipeCode || '', reference || '']
    );
    // Limpa cache em memória também (próximo request relê do banco com o valor novo).
    fipeMemCache.delete(cacheKey);
    console.log('FIPE: override manual salvo pra', cacheKey, '→', fipeValue);
    res.json({ success: true, data: { cacheKey, fipeValue, fipeModel } });
  } catch (err) {
    console.error('[fipe/override] erro:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/fipe/test', async (req, res) => {
  // Diagnóstico do token sem expor o valor: confirma se a env var chegou no
  // backend e se está completa (JWT = 3 partes separadas por ponto).
  const tokenInfo = {
    tokenConfigured: !!FIPE_TOKEN,
    tokenLength: FIPE_TOKEN ? FIPE_TOKEN.length : 0,
    tokenParts: FIPE_TOKEN ? FIPE_TOKEN.split('.').length : 0
  };
  try {
    const testData = await fipeGet('/cars/brands');
    res.json({ success: true, count: testData.length, sample: testData.slice(0, 3), ...tokenInfo });
  } catch (err) {
    res.json({ success: false, error: err.message, status: err.response?.status, data: err.response?.data, ...tokenInfo });
  }
});

async function saveVehicleSnapshot(advertisementId, data) {
  if (!data || !advertisementId) return;
  try {
    const { pool } = require('../services/db');
    const photos = data.photos ? JSON.stringify(data.photos) : null;
    await pool.query(
      `INSERT INTO vehicle_snapshots (advertisement_id, event_id, brand, model, version, year_manufacture, year_model, km, color, fuel, transmission, bodywork, location, uf, comitente, plate, photos, fipe_value, fipe_model, fipe_score, description, initial_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (advertisement_id) DO NOTHING`,
      [
        advertisementId,
        data.event_id || null,
        data.brand || '',
        data.model || '',
        data.version || '',
        data.year_manufacture || null,
        data.year_model || null,
        data.km || 0,
        data.color || '',
        data.fuel || '',
        data.transmission || '',
        data.bodywork || '',
        data.location || '',
        data.uf || '',
        data.comitente || '',
        data.plate || '',
        photos,
        data.fipe_value || null,
        data.fipe_model || '',
        data.fipe_score || '',
        data.description || '',
        data.initial_price || null
      ]
    );
  } catch (err) {
    console.error('Erro ao salvar snapshot:', err.message);
  }
}

router.get('/vehicle-history', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const result = await pool.query('SELECT * FROM vehicle_snapshots ORDER BY created_at DESC LIMIT 200');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/vehicle-history/:advertisementId', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const result = await pool.query('SELECT * FROM vehicle_snapshots WHERE advertisement_id = $1', [req.params.advertisementId]);
    if (result.rows.length > 0) {
      const row = result.rows[0];
      if (row.photos) row.photos = JSON.parse(row.photos);
      res.json({ success: true, data: row });
    } else {
      res.json({ success: false, error: 'Snapshot não encontrado' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Invalida o cache de veículos quando o WebSocket da origem avisa que rolou
// um lance — assim o poll-relâmpago do cliente busca os dados frescos (com o
// finish_date_offer estendido) em vez de pegar uma versão "suja" do cache.
function invalidateVehiclesCache() {
  for (const key of dealersCache.keys()) {
    if (key.startsWith('vehicles_')) dealersCache.delete(key);
  }
}

module.exports = router;
module.exports.invalidateVehiclesCache = invalidateVehiclesCache;

