// Rotas do app de Figurinhas (Copa 2026) — Fase 2: Radar + Reputação.
//
// Isolado de propósito: cria as próprias tabelas (fig_*) e não depende de
// nada do fluxo de veículos. Se este módulo falhar ao carregar, o server.js
// segue subindo normal (igual ao módulo de marketing).
//
// Identidade leve: cada aparelho gera um clientId (uuid no localStorage) —
// sem senha. Suficiente pra um app de troca de figurinhas e remove atrito de
// cadastro, que é onde os concorrentes perdem usuário.

const express = require('express');
const router = express.Router();
const { pool } = require('../services/db');
const { ALL_IDS, ID_SET, TOTAL } = require('../services/figurinhasAlbum');
const ID_INDEX = new Map(ALL_IDS.map((id, i) => [id, i])); // ordem do álbum p/ ordenar
const byAlbum = (a, b) => ID_INDEX.get(a) - ID_INDEX.get(b);

// Visão da IA pra ler o código da figurinha (mesma chave do módulo de marketing).
let anthropic = null;
try {
  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
} catch (e) { anthropic = null; }
const SCAN_MODEL = process.env.FIG_SCAN_MODEL || 'claude-haiku-4-5-20251001';

// ---- Criação preguiçosa das tabelas (idempotente) -------------------------
let tablesReady = null;
function ensureTables() {
  if (tablesReady) return tablesReady;
  tablesReady = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fig_collectors (
        id SERIAL PRIMARY KEY,
        client_id VARCHAR(64) UNIQUE NOT NULL,
        nick VARCHAR(60) NOT NULL,
        album VARCHAR(80) DEFAULT 'Copa do Mundo 2026',
        total INTEGER DEFAULT 980,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        city VARCHAR(120),
        whatsapp VARCHAR(40),
        owned JSONB DEFAULT '{}'::jsonb,
        rating_sum INTEGER DEFAULT 0,
        rating_count INTEGER DEFAULT 0,
        trades_done INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fig_collectors_geo ON fig_collectors(lat, lng)`).catch(() => {});
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fig_ratings (
        id SERIAL PRIMARY KEY,
        rater_client VARCHAR(64) NOT NULL,
        rated_id INTEGER NOT NULL REFERENCES fig_collectors(id) ON DELETE CASCADE,
        stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
        comment TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(rater_client, rated_id)
      )
    `);
  })().catch((e) => {
    tablesReady = null; // permite tentar de novo no próximo request
    throw e;
  });
  return tablesReady;
}

// ---- Helpers --------------------------------------------------------------

// Normaliza o mapa owned vindo do front ({ "MEX5": 2 }) -> id->qtd, validando
// cada id contra a estrutura oficial do álbum.
function normOwned(owned) {
  const out = {};
  if (owned && typeof owned === 'object') {
    for (const k in owned) {
      const q = parseInt(owned[k], 10);
      if (ID_SET.has(k) && q >= 1) out[k] = q;
    }
  }
  return out;
}

// Conjunto de repetidas (tenho 2+) e de faltantes (qualquer id do álbum sem posse).
function spareSet(owned) {
  const s = {};
  for (const id in owned) if (owned[id] >= 2) s[id] = true;
  return s;
}
function missingSet(owned) {
  const s = {};
  for (const id of ALL_IDS) if (!owned[id]) s[id] = true;
  return s;
}

// Distância em km entre dois pontos (Haversine).
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function ratingOf(row) {
  return row.rating_count > 0
    ? Math.round((row.rating_sum / row.rating_count) * 10) / 10
    : null;
}

// ---- Rotas ----------------------------------------------------------------

// Sincroniza coleção + perfil + localização. Cria ou atualiza o colecionador.
router.post('/figurinhas/sync', async (req, res) => {
  try {
    await ensureTables();
    const { clientId, nick, album, total, lat, lng, city, whatsapp, owned } = req.body || {};
    if (!clientId || typeof clientId !== 'string' || clientId.length > 64) {
      return res.status(400).json({ success: false, error: 'clientId inválido' });
    }
    const safeNick = String(nick || 'Colecionador').trim().slice(0, 60) || 'Colecionador';
    const safeTotal = Math.min(Math.max(parseInt(total, 10) || TOTAL, 1), 10000);
    const ownedJson = JSON.stringify(normOwned(owned));
    const hasGeo = typeof lat === 'number' && typeof lng === 'number';

    const result = await pool.query(
      `INSERT INTO fig_collectors (client_id, nick, album, total, lat, lng, city, whatsapp, owned, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb, NOW())
       ON CONFLICT (client_id) DO UPDATE SET
         nick=$2, album=COALESCE($3, fig_collectors.album), total=$4,
         lat=COALESCE($5, fig_collectors.lat), lng=COALESCE($6, fig_collectors.lng),
         city=COALESCE($7, fig_collectors.city), whatsapp=$8,
         owned=$9::jsonb, updated_at=NOW()
       RETURNING id`,
      [clientId, safeNick, album || null, safeTotal,
       hasGeo ? lat : null, hasGeo ? lng : null,
       city ? String(city).slice(0, 120) : null,
       whatsapp ? String(whatsapp).replace(/[^\d+]/g, '').slice(0, 40) : null,
       ownedJson]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Radar: colecionadores próximos, ordenados por nº de trocas possíveis e
// distância. O matching é calculado no servidor contra a coleção do solicitante.
router.get('/figurinhas/radar', async (req, res) => {
  try {
    await ensureTables();
    const clientId = req.query.clientId;
    const radius = Math.min(Math.max(parseFloat(req.query.radius) || 50, 1), 2000); // km
    const limit = Math.min(parseInt(req.query.limit, 10) || 40, 100);
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId obrigatório' });

    const meRes = await pool.query('SELECT * FROM fig_collectors WHERE client_id=$1', [clientId]);
    if (!meRes.rows.length) return res.status(404).json({ success: false, error: 'Ative o radar primeiro (sync)' });
    const me = meRes.rows[0];
    if (me.lat == null || me.lng == null) {
      return res.status(400).json({ success: false, error: 'Sem localização — ative o GPS e sincronize' });
    }

    const myOwned = normOwned(me.owned);
    const mySpares = spareSet(myOwned);
    const myMissing = missingSet(myOwned);

    // Pré-filtro por bounding box (barato) antes do Haversine preciso.
    const latDelta = radius / 111;
    const lngDelta = radius / (111 * Math.max(Math.cos((me.lat * Math.PI) / 180), 0.01));
    const cand = await pool.query(
      `SELECT * FROM fig_collectors
        WHERE client_id <> $1 AND lat IS NOT NULL AND lng IS NOT NULL
          AND lat BETWEEN $2 AND $3 AND lng BETWEEN $4 AND $5
        LIMIT 500`,
      [clientId, me.lat - latDelta, me.lat + latDelta, me.lng - lngDelta, me.lng + lngDelta]
    );

    const out = [];
    for (const c of cand.rows) {
      const dist = distanceKm(me.lat, me.lng, c.lat, c.lng);
      if (dist > radius) continue;
      const theirOwned = normOwned(c.owned);
      const theirSpares = spareSet(theirOwned);
      const theirMissing = missingSet(theirOwned);

      const give = []; // minhas repetidas que ele precisa
      for (const id in mySpares) if (theirMissing[id]) give.push(id);
      const get = [];  // repetidas dele que eu preciso
      for (const id in theirSpares) if (myMissing[id]) get.push(id);
      if (!give.length && !get.length) continue; // só mostra quem tem troca

      give.sort(byAlbum); get.sort(byAlbum);
      out.push({
        id: c.id,
        nick: c.nick,
        city: c.city,
        distanceKm: Math.round(dist * 10) / 10,
        rating: ratingOf(c),
        ratingCount: c.rating_count,
        tradesDone: c.trades_done,
        hasWhats: !!c.whatsapp,
        giveCount: give.length,
        getCount: get.length,
        give: give.slice(0, 60),
        get: get.slice(0, 60),
      });
    }

    // Mais trocas primeiro; empate, mais perto; depois melhor reputação.
    out.sort((a, b) =>
      (b.giveCount + b.getCount) - (a.giveCount + a.getCount) ||
      a.distanceKm - b.distanceKm ||
      (b.rating || 0) - (a.rating || 0)
    );
    res.json({ success: true, count: out.length, collectors: out.slice(0, limit) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Detalhe de um colecionador (perfil + contato + avaliações recentes).
router.get('/figurinhas/collector/:id', async (req, res) => {
  try {
    await ensureTables();
    const id = parseInt(req.params.id, 10);
    const r = await pool.query('SELECT * FROM fig_collectors WHERE id=$1', [id]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
    const c = r.rows[0];
    const ratings = await pool.query(
      'SELECT stars, comment, created_at FROM fig_ratings WHERE rated_id=$1 ORDER BY created_at DESC LIMIT 10',
      [id]
    );
    res.json({
      success: true,
      collector: {
        id: c.id, nick: c.nick, city: c.city, album: c.album,
        whatsapp: c.whatsapp, rating: ratingOf(c), ratingCount: c.rating_count,
        tradesDone: c.trades_done,
      },
      ratings: ratings.rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Avaliar um colecionador (1 voto por par; reenviar atualiza). Recalcula a
// média denormalizada a partir da tabela de avaliações.
router.post('/figurinhas/rate', async (req, res) => {
  try {
    await ensureTables();
    const { clientId, ratedId, stars, comment } = req.body || {};
    const s = parseInt(stars, 10);
    const id = parseInt(ratedId, 10);
    if (!clientId || !id || !(s >= 1 && s <= 5)) {
      return res.status(400).json({ success: false, error: 'Dados inválidos (estrelas 1–5)' });
    }
    // Não deixa avaliar a si mesmo.
    const self = await pool.query('SELECT id FROM fig_collectors WHERE client_id=$1 AND id=$2', [clientId, id]);
    if (self.rows.length) return res.status(400).json({ success: false, error: 'Não dá pra se autoavaliar' });

    await pool.query(
      `INSERT INTO fig_ratings (rater_client, rated_id, stars, comment)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (rater_client, rated_id) DO UPDATE SET stars=$3, comment=$4, created_at=NOW()`,
      [clientId, id, s, comment ? String(comment).slice(0, 280) : null]
    );
    await pool.query(
      `UPDATE fig_collectors SET
         rating_sum=(SELECT COALESCE(SUM(stars),0) FROM fig_ratings WHERE rated_id=$1),
         rating_count=(SELECT COUNT(*) FROM fig_ratings WHERE rated_id=$1)
       WHERE id=$1`,
      [id]
    );
    const r = await pool.query('SELECT rating_sum, rating_count FROM fig_collectors WHERE id=$1', [id]);
    res.json({ success: true, rating: ratingOf(r.rows[0]), ratingCount: r.rows[0].rating_count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Marca uma troca concluída (incrementa o contador dos dois lados). Opcional,
// alimenta a reputação ("X trocas feitas").
router.post('/figurinhas/trade-done', async (req, res) => {
  try {
    await ensureTables();
    const { clientId, otherId } = req.body || {};
    const oid = parseInt(otherId, 10);
    if (!clientId || !oid) return res.status(400).json({ success: false, error: 'Dados inválidos' });
    await pool.query('UPDATE fig_collectors SET trades_done = trades_done + 1 WHERE client_id=$1', [clientId]);
    await pool.query('UPDATE fig_collectors SET trades_done = trades_done + 1 WHERE id=$1', [oid]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Lê o código de uma figurinha a partir de um recorte (base64) usando a visão
// da Claude — muito mais confiável que OCR no navegador.
router.post('/figurinhas/scan', async (req, res) => {
  try {
    if (!anthropic) {
      return res.status(503).json({ success: false, error: 'Leitura por IA indisponível (sem ANTHROPIC_API_KEY)' });
    }
    let { image } = req.body || {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ success: false, error: 'imagem ausente' });
    }
    let media = 'image/jpeg', data = image;
    const m = image.match(/^data:(image\/[\w.+-]+);base64,(.*)$/);
    if (m) { media = m[1]; data = m[2]; }
    if (data.length > 6000000) return res.status(413).json({ success: false, error: 'imagem muito grande' });

    const completion = await anthropic.messages.create({
      model: SCAN_MODEL,
      max_tokens: 60,
      system: 'Você lê o código impresso numa figurinha do álbum Panini Copa do Mundo 2026. ' +
        'A imagem é um recorte mostrando um código curto como "ECU 20", "BRA 5", "FWC 13" ou "CC 7" ' +
        '(sigla de 2 a 4 letras maiúsculas + um número). Responda APENAS com um JSON: ' +
        '{"code":"ECU","number":20}. Se não conseguir ler, use null no campo. Nada além do JSON.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: media, data: data } },
          { type: 'text', text: 'Código e número? Só o JSON.' },
        ],
      }],
    });
    const text = (completion.content || []).map((c) => c.text || '').join(' ').trim();
    let out = null;
    try { out = JSON.parse((text.match(/\{[\s\S]*\}/) || [text])[0]); } catch (e) { out = null; }
    const code = out && out.code ? String(out.code).toUpperCase().replace(/[^A-Z]/g, '') : null;
    const number = out && out.number != null ? parseInt(out.number, 10) : null;
    res.json({ success: true, code: code || null, number: (number != null && !isNaN(number)) ? number : null, raw: text });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Status da leitura por IA (pra avisar o usuário se a chave não está ativa).
router.get('/figurinhas/scan-status', (req, res) => {
  res.json({ success: true, ready: !!anthropic, model: SCAN_MODEL });
});

module.exports = router;
