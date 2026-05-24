const express = require('express');
const router = express.Router();
const axios = require('axios');
const { PDFDocument, rgb } = require('pdf-lib');
const dealers = require('../services/dealers');
const { requireApproved, requireAdmin } = require('./auth');
const { pool } = require('../services/db');
const { sanitizeText, redactDealerFromPdf } = require('../services/dealerSanitize');

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

function getCachedOrFetch(key, fetchFn) {
  const cached = dealersCache.get(key);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return Promise.resolve(cached.data);
  }
  return fetchFn().then(data => {
    dealersCache.set(key, { data, timestamp: Date.now() });
    return data;
  });
}

// API FIPE oficial (fipe.online) - 1000 consultas/dia grátis
const FIPE_API = 'https://api.fipe.online/api/v2';
const FIPE_TOKEN = process.env.FIPE_API_TOKEN;
const fipeMemCache = new Map();

async function fipeGet(path) {
  const res = await axios.get(FIPE_API + path, {
    headers: { 'Authorization': `Bearer ${FIPE_TOKEN}` }
  });
  return res.data;
}

function normalize(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
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

  const wordsSearch = nb.split(/\s+/).filter(w => w.length > 1);
  const wordsTarget = na.split(/\s+/).filter(w => w.length > 1);
  let matches = 0;

  for (const w of wordsSearch) {
    if (wordsTarget.some(wt => wt === w || wt.includes(w) || w.includes(wt))) {
      matches++;
    }
  }

  return wordsSearch.length > 0 ? matches / wordsSearch.length : 0;
}

async function fetchFipeValue(brand, model, version, year) {
  const cacheKey = `${brand}|${model}|${version}|${year}`.toLowerCase();

  // 1. Verificar cache em memória
  if (fipeMemCache.has(cacheKey)) {
    console.log('FIPE: Cache memória hit');
    return fipeMemCache.get(cacheKey);
  }

  // 2. Verificar cache no banco de dados (válido por 30 dias)
  try {
    const dbCache = await pool.query(
      `SELECT * FROM fipe_cache WHERE cache_key = $1 AND updated_at > NOW() - INTERVAL '30 days'`,
      [cacheKey]
    );
    if (dbCache.rows.length > 0) {
      const row = dbCache.rows[0];
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


router.get('/laudo-proxy', async (req, res) => {
  let originalBuf = null;
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send('URL required');

    if (!isAllowedUrl(url)) {
      console.warn('SSRF bloqueado: tentativa de acesso a URL não permitida:', url);
      return res.status(403).send('URL não permitida');
    }

    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    originalBuf = Buffer.from(response.data);

    const cleaned = await redactDealerFromPdf(originalBuf);

    res.set('Content-Type', 'application/pdf');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(cleaned);
  } catch (err) {
    console.error('Laudo proxy error:', err.message);
    if (originalBuf) {
      // Sempre prefere mostrar o laudo original do que falhar 500
      res.set('Content-Type', 'application/pdf');
      return res.send(originalBuf);
    }
    res.status(500).send('Error processing PDF');
  }
});

router.get('/img', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send('URL required');

    // Validação SSRF: apenas domínios permitidos
    if (!isAllowedUrl(url)) {
      console.warn('SSRF bloqueado: tentativa de acesso a imagem não permitida:', url);
      return res.status(403).send('URL não permitida');
    }

    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
    res.set('Content-Type', response.headers['content-type']);
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
    const filtered = events.filter(e => {
      const finish = new Date(e.finish_date_display);
      const margin = new Date(finish.getTime() + 60 * 60 * 1000); // +1h de margem
      if (margin < now) return false;
      const nameLower = e.name.toLowerCase();
      if (nameLower.includes('cancelado') || nameLower.includes('vinculos')) return false;
      if (nameLower.includes('pesado') || nameLower.includes('implemento')) return false;
      return true;
    });
    filtered.sort((a, b) => new Date(a.finish_date_event) - new Date(b.finish_date_event));
    res.json({ success: true, data: filtered });
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
    const vehicles = await getCachedOrFetch(`vehicles_${req.params.eventId}`, () => dealers.getEventVehicles(req.params.eventId));
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

      // Aplicar spread na oferta atual
      let offerActual = v.offer_actual ? { ...v.offer_actual } : null;
      if (offerActual && offerActual.price) {
        offerActual.price = applySpread(offerActual.price);
      }

      return {
        id: v.id,
        vehicle: v.vehicle,
        shop: { name: v.shop.name, city: v.shop.city, state: info.uf || v.shop.state },
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
    res.json({ success: true, data: mapped });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/vehicles/:advertisementId/offers', async (req, res) => {
  try {
    const offers = await dealers.getOffers(req.params.advertisementId);
    res.json({ success: true, data: offers });
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

router.post('/vehicles/:advertisementId/bid', requireApproved, async (req, res) => {
  try {
    const { value, vehicleData } = req.body;
    if (!value) return res.status(400).json({ success: false, error: 'Valor obrigatório' });

    // Remove spread antes de enviar ao Dealers Club
    const realValue = removeSpread(value);
    const result = await dealers.placeBid(parseInt(req.params.advertisementId), realValue);

    // Salvar lance no banco local
    try {
      const { pool } = require('../services/db');
      const user = req.user || {};
      await pool.query(
        'INSERT INTO bids (user_id, user_name, user_email, advertisement_id, vehicle_brand, vehicle_model, bid_value, bid_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [user.id || null, user.name || 'Cliente', user.email || '', parseInt(req.params.advertisementId), req.body.brand || '', req.body.model || '', value, 'manual']
      );
    } catch(dbErr) { console.error('Erro ao salvar lance:', dbErr.message); }

    // Salvar snapshot do veículo
    if (vehicleData) saveVehicleSnapshot(parseInt(req.params.advertisementId), vehicleData);

    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message;
    res.status(status).json({ success: false, error: message });
  }
});

router.post('/vehicles/:advertisementId/auto-bid', requireApproved, async (req, res) => {
  try {
    const { maxValue, tiebreaker, vehicleData } = req.body;
    if (!maxValue) return res.status(400).json({ success: false, error: 'Valor máximo obrigatório' });

    // Remove spread antes de enviar ao Dealers Club
    const realMaxValue = removeSpread(maxValue);
    const result = await dealers.placeAutoBid(parseInt(req.params.advertisementId), realMaxValue, tiebreaker || false);

    // Salvar lance no banco local
    try {
      const { pool } = require('../services/db');
      const user = req.user || {};
      await pool.query(
        'INSERT INTO bids (user_id, user_name, user_email, advertisement_id, vehicle_brand, vehicle_model, bid_value, bid_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [user.id || null, user.name || 'Cliente', user.email || '', parseInt(req.params.advertisementId), req.body.brand || '', req.body.model || '', maxValue, 'automatico']
      );
    } catch(dbErr) { console.error('Erro ao salvar lance:', dbErr.message); }

    // Salvar snapshot do veículo
    if (vehicleData) saveVehicleSnapshot(parseInt(req.params.advertisementId), vehicleData);

    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message;
    res.status(status).json({ success: false, error: message });
  }
});

router.post('/vehicles/:advertisementId/buy-now', requireApproved, async (req, res) => {
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

router.get('/dealers-purchases', async (req, res) => {
  try {
    const { pool } = require('../services/db');

    // Lê todos os veículos do banco local + total de custos via JOIN
    const result = await pool.query(`
      SELECT
        p.*,
        COALESCE(
          (SELECT SUM(amount) FROM vehicle_costs WHERE vehicle_id = p.id),
          0
        ) AS total_costs
      FROM purchases p
      LEFT JOIN hidden_vehicles h ON h.vehicle_id = p.id
      WHERE h.vehicle_id IS NULL
      ORDER BY p.created_at DESC
    `);

    const vehicles = [];
    for (const v of result.rows) {
      // Parse do array de fotos (TEXT com JSON). Fallback pra [image] se vazio.
      let photos = [];
      if (v.photos) {
        try {
          const parsed = JSON.parse(v.photos);
          if (Array.isArray(parsed)) photos = parsed.filter(Boolean);
        } catch (e) { /* ignora JSON inválido */ }
      }
      if (photos.length === 0 && v.image) photos = [v.image];

      // Busca FIPE se não tiver
      let fipePrice = parseFloat(v.fipe_price) || 0;
      if (!fipePrice && v.brand && v.model && v.year) {
        const fipeResult = await fetchFipeValue(v.brand, v.model, v.version || '', v.year);
        if (fipeResult) fipePrice = fipeResult.value;
      }

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
        photos: photos
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

    // Parse das fotos
    let photos = [];
    if (v.photos) {
      try {
        const parsed = JSON.parse(v.photos);
        if (Array.isArray(parsed)) photos = parsed.filter(Boolean).map(url => ({ url }));
      } catch (e) { /* ignora */ }
    }
    if (photos.length === 0 && v.image) photos = [{ url: v.image }];

    // Custos
    const cRes = await pool.query(
      'SELECT id, category, description, amount, cost_date FROM vehicle_costs WHERE vehicle_id = $1 ORDER BY id',
      [vId]
    );
    const costs = cRes.rows;

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
      laudo: v.laudo
    };

    res.json({ success: true, data: { vehicle, photos, fipe, costs } });
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

router.post('/stock-cost', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { vehicleId, category, description, amount } = req.body;
    if (!vehicleId || !amount) {
      return res.status(400).json({ success: false, error: 'vehicleId e amount são obrigatórios' });
    }
    const result = await pool.query(
      `INSERT INTO vehicle_costs (vehicle_id, category, description, amount, cost_date)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [parseInt(vehicleId), category || 'Outros', description || category || '', parseFloat(amount), new Date().toISOString().split('T')[0]]
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
router.get('/dealers-accounts', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const result = await pool.query('SELECT id, name, email, shop_id, whitelabel_id, created_at FROM dealers_accounts ORDER BY id');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/dealers-accounts', async (req, res) => {
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

router.delete('/dealers-accounts/:id', async (req, res) => {
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

    // Verificar se já existe no banco (evita scrape desnecessário)
    const dup = await pool.query('SELECT id, brand, model FROM purchases WHERE dealers_uuid = $1', [uuid]);
    if (dup.rows.length > 0) {
      const v = dup.rows[0];
      return res.json({ success: false, error: `Esse anúncio já está no estoque (id ${v.id}: ${v.brand} ${v.model}). Exclua antes se quiser reimportar.` });
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

    // Insert
    const result = await pool.query(`
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

    const v = result.rows[0];
    res.json({
      success: true,
      id: v.id,
      message: `${v.brand} ${v.model} ${v.year} importado com ${data.fotos.length} fotos (conta: ${usedAccount}).`,
      data: { ...data, dbId: v.id, usedAccount }
    });
  } catch (err) {
    console.error('[import-from-url] erro:', err.message);
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

          // Verificar se já existe (evitar duplicata)
          const exists = await pool.query(
            'SELECT id FROM purchases WHERE brand=$1 AND model=$2 AND year=$3 AND price=$4',
            [brand, model, String(year), price]
          );
          if (exists.rows.length > 0) continue;

          await pool.query(
            `INSERT INTO purchases (brand, model, version, year, km, color, price, status, notes, fuel, transmission, city, image)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [brand, model, version, String(year), km, color, price, 'disponivel', 'Importado de: ' + account.name, fuel, transmission, city, image]
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
    const result = await pool.query('SELECT * FROM bids ORDER BY created_at DESC LIMIT 100');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.json({ success: false, error: 'Erro ao buscar lances' });
  }
});

router.get('/admin/user/:id/profile', requireAdmin, async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const userId = parseInt(req.params.id);
    if (isNaN(userId)) return res.json({ success: false, error: 'ID inválido' });
    const userRes = await pool.query('SELECT id, name, email, phone, cpf, approved, created_at FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return res.json({ success: false, error: 'Usuário não encontrado' });
    const bidsRes = await pool.query('SELECT * FROM bids WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    res.json({ success: true, data: { user: userRes.rows[0], bids: bidsRes.rows } });
  } catch (err) {
    res.json({ success: false, error: 'Erro ao buscar perfil' });
  }
});

router.get('/my-bids', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.json({ success: true, data: [] });
    if (!process.env.JWT_SECRET) return res.json({ success: true, data: [] }); // Falha segura
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const bidsRes = await pool.query('SELECT * FROM bids WHERE user_id = $1 ORDER BY created_at DESC', [decoded.id]);

    // Para cada lance, verificar se está ganhando ou perdendo
    const bids = bidsRes.rows;
    const checkedBids = [];
    const checkedAds = new Map();

    for (const bid of bids) {
      let status = 'pendente';
      try {
        if (!checkedAds.has(bid.advertisement_id)) {
          const offers = await dealers.getOffers(String(bid.advertisement_id));
          checkedAds.set(bid.advertisement_id, offers);
        }
        const offers = checkedAds.get(bid.advertisement_id);
        if (offers && offers.length > 0) {
          const bestOffer = offers.reduce((max, o) => (parseFloat(o.price || o.value || 0) > parseFloat(max.price || max.value || 0)) ? o : max, offers[0]);
          const bestValue = parseFloat(bestOffer.price || bestOffer.value || 0);
          if (parseFloat(bid.bid_value) >= bestValue) status = 'ganhando';
          else status = 'perdendo';
        }
      } catch(e) { status = 'pendente'; }
      checkedBids.push({ ...bid, status });
    }

    res.json({ success: true, data: checkedBids });
  } catch (err) {
    res.json({ success: true, data: [] });
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
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await axios.get(url, { timeout: 15000 });
      parallelumCache.set(url, { ts: Date.now(), res });
      return res;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status === 429 || status === 503 || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
        const wait = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
        await new Promise(r => setTimeout(r, wait));
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

router.get('/fipe/versions', async (req, res) => {
  try {
    const { brand, model, year } = req.query;
    if (!brand || !model) {
      return res.status(400).json({ success: false, error: 'brand e model são obrigatórios' });
    }
    const yearNum = parseInt(String(year || '').split('/')[0]) || null;

    // 1. Achar marca (cacheado — lista de marcas muda raramente)
    const brandsRes = await parallelumGet(PARALLELUM + '/marcas');
    const brandNorm = parallelumNormalize(brand);
    const marca = brandsRes.data.find(b => parallelumNormalize(b.nome) === brandNorm)
      || brandsRes.data.find(b => parallelumNormalize(b.nome).includes(brandNorm) || brandNorm.includes(parallelumNormalize(b.nome)));
    if (!marca) return res.json({ success: false, error: 'Marca não encontrada: ' + brand });

    // 2. Listar modelos da marca (cacheado — modelos por marca também mudam pouco)
    const modelsRes = await parallelumGet(PARALLELUM + '/marcas/' + marca.codigo + '/modelos');
    const modelNorm = parallelumNormalize(model);
    const matchingModels = modelsRes.data.modelos.filter(m =>
      parallelumNormalize(m.nome).includes(modelNorm)
    );
    if (matchingModels.length === 0) {
      return res.json({ success: false, error: 'Nenhuma versão encontrada para o modelo: ' + model });
    }

    // 3. Pra cada modelo, buscar anos com concorrência limitada (evita 429)
    const yearsResults = await runPool(matchingModels, 3, async (m) => {
      const r = await parallelumGet(PARALLELUM + '/marcas/' + marca.codigo + '/modelos/' + m.codigo + '/anos');
      return { model: m, years: r.data };
    });

    // Filtra os que têm o ano desejado
    const versions = [];
    for (const r of yearsResults) {
      if (r.status !== 'fulfilled') continue;
      const { model, years } = r.value;
      for (const y of years) {
        const yearOnly = parseInt(y.codigo.split('-')[0]);
        if (yearNum && yearOnly !== yearNum) continue;
        versions.push({
          brandCode: marca.codigo,
          modelCode: model.codigo,
          yearCode: y.codigo,
          modelName: model.nome,
          yearName: y.nome
        });
      }
    }

    // 4. Pra cada versão filtrada, buscar valor atual (concorrência limitada)
    const detailResults = await runPool(versions, 3, async (v) => {
      const r = await parallelumGet(`${PARALLELUM}/marcas/${v.brandCode}/modelos/${v.modelCode}/anos/${v.yearCode}`);
      return { v, d: r.data };
    });

    const detailed = [];
    for (const r of detailResults) {
      if (r.status !== 'fulfilled') continue;
      const { v, d } = r.value;
      detailed.push({
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
    }

    // Ordena por valor (preço maior primeiro = versão mais completa)
    detailed.sort((a, b) => b.value - a.value);
    res.json({ success: true, data: detailed, count: detailed.length });
  } catch (err) {
    console.error('[fipe/versions] erro:', err.message);
    const status = err.response?.status;
    const userMsg = status === 429
      ? 'FIPE com muitas consultas no momento. Tente novamente em alguns segundos.'
      : err.message;
    res.status(status === 429 ? 429 : 500).json({ success: false, error: userMsg, rateLimited: status === 429 });
  }
});

// Atualiza FIPE de um veículo no estoque escolhendo um fipeCode específico.
router.post('/stock-fipe-update', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { vehicleId, brandCode, modelCode, yearCode } = req.body;
    if (!vehicleId || !brandCode || !modelCode || !yearCode) {
      return res.status(400).json({ success: false, error: 'vehicleId, brandCode, modelCode, yearCode obrigatórios' });
    }
    // Buscar valor atual da FIPE (com retry no 429)
    const r = await parallelumGet(`${PARALLELUM}/marcas/${brandCode}/modelos/${modelCode}/anos/${yearCode}`);
    const d = r.data;
    const value = parseFloat(String(d.Valor).replace('R$ ', '').replace(/\./g, '').replace(',', '.'));

    await pool.query(
      'UPDATE purchases SET fipe_price = $1 WHERE id = $2',
      [value, parseInt(vehicleId)]
    );

    res.json({
      success: true,
      data: {
        fipePrice: value,
        modelName: d.Modelo,
        fipeCode: d.CodigoFipe,
        reference: d.MesReferencia,
        year: d.AnoModelo
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

router.get('/fipe/test', async (req, res) => {
  try {
    const testData = await fipeGet('/cars/brands');
    res.json({ success: true, count: testData.length, sample: testData.slice(0, 3) });
  } catch (err) {
    res.json({ success: false, error: err.message, status: err.response?.status, data: err.response?.data });
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

module.exports = router;

