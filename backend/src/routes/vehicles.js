const express = require('express');
const router = express.Router();
const axios = require('axios');
const { PDFDocument, rgb } = require('pdf-lib');
const dealers = require('../services/dealers');
const { requireApproved } = require('./auth');

// Usando API Parallelum (mais confiável, não bloqueia IPs de cloud)
const FIPE_API = 'https://parallelum.com.br/fipe/api/v1';
const fipeCache = new Map();

async function fipeGet(path) {
  const res = await axios.get(FIPE_API + path);
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
  const cacheKey = `${brand}|${model}|${version}|${year}`;
  if (fipeCache.has(cacheKey)) return fipeCache.get(cacheKey);

  const categories = ['carros', 'motos'];
  for (const categoryType of categories) {
    try {
      const marcas = await fipeGet(`/${categoryType}/marcas`);
      const brandNorm = normalize(brand);
      const marca = marcas.find(m => normalize(m.nome) === brandNorm)
        || marcas.find(m => normalize(m.nome).includes(brandNorm) || brandNorm.includes(normalize(m.nome)));
      if (!marca) continue;

      const modelos = await fipeGet(`/${categoryType}/marcas/${marca.codigo}/modelos`);
      const searchStr = `${model} ${version}`.trim();
      const modelNorm = normalize(model);

      let bestModel = null;
      let bestScore = 0;
      let candidates = [];
      for (const m of modelos) {
        const mNorm = normalize(m.nome);
        if (!mNorm.includes(modelNorm)) continue;
        const score = similarity(m.nome, searchStr);
        if (score >= 0.3) candidates.push({ model: m, score });
      }
      if (candidates.length === 0) {
        for (const m of modelos) {
          const score = similarity(m.nome, searchStr);
          if (score >= 0.3) candidates.push({ model: m, score });
        }
      }
      candidates.sort((a, b) => b.score - a.score);

      for (const candidate of candidates) {
        try {
          const anos = await fipeGet(`/${categoryType}/marcas/${marca.codigo}/modelos/${candidate.model.codigo}/anos`);
          const yearStr = String(year);
          let ano = anos.find(a => a.codigo.startsWith(yearStr + '-'));
          if (!ano) ano = anos.find(a => a.nome.includes(yearStr));
          if (!ano) continue;

          const data = await fipeGet(`/${categoryType}/marcas/${marca.codigo}/modelos/${candidate.model.codigo}/anos/${ano.codigo}`);
          const valorNum = parseFloat(data.Valor.replace('R$ ', '').replace(/\./g, '').replace(',', '.'));
          const result = { value: valorNum, model: data.Modelo, year: data.AnoModelo, reference: data.MesReferencia, fipeCode: data.CodigoFipe, matchScore: candidate.score.toFixed(2) };
          fipeCache.set(cacheKey, result);
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
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send('URL required');
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const zlib = require('zlib');
    let pdfStr = Buffer.from(response.data).toString('binary');

    const parts = pdfStr.split(/(stream\r?\n[\s\S]*?endstream)/);
    let result = '';
    let modified = false;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const streamMatch = part.match(/^stream(\r?\n)([\s\S]*?)endstream$/);
      if (streamMatch) {
        try {
          const compressed = Buffer.from(streamMatch[2], 'binary');
          const dec = zlib.inflateSync(compressed).toString('binary');
          if (/dealer/i.test(dec)) {
            modified = true;
            const newDec = dec.replace(/\(([^)]*[Dd][Ee][Aa][Ll][Ee][Rr][^)]*)\)/g, (m, inner) => {
              return '(' + ' '.repeat(inner.length) + ')';
            });
            let prev = result;
            prev = prev.replace(/\/Filter\s*\/FlateDecode\s*/g, '');
            prev = prev.replace(/\/Length\s+\d+/, '/Length ' + newDec.length);
            result = prev + 'stream' + streamMatch[1] + newDec + 'endstream';
            continue;
          }
        } catch(e) {}
      }
      result += part;
    }

    if (modified) {
      res.set('Content-Type', 'application/pdf');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(Buffer.from(result, 'binary'));
    } else {
      res.set('Content-Type', 'application/pdf');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(Buffer.from(response.data));
    }
  } catch (err) {
    console.error('Laudo proxy error:', err.message);
    try {
      const resp = await axios.get(req.query.url, { responseType: 'arraybuffer' });
      res.set('Content-Type', 'application/pdf');
      res.send(resp.data);
    } catch(e) {
      res.status(500).send('Error processing PDF');
    }
  }
});

router.get('/img', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send('URL required');
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    res.set('Content-Type', response.headers['content-type']);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(response.data);
  } catch (err) {
    res.status(404).send('Image not found');
  }
});

router.get('/events', async (req, res) => {
  try {
    const events = await dealers.getEvents();
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
    const event = await dealers.getEventDetails(req.params.eventId);
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
    const vehicles = await dealers.getEventVehicles(req.params.eventId);
    const mapped = vehicles.map(v => {
      const info = extractInfo(v.vehicle.description);
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
        description: v.vehicle.description || null
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
    // Puxar veiculos do sistema VDP (vendasdiretaspremium)
    const loginRes = await axios.post('https://vendasdiretaspremium.manus.space/api/trpc/auth.loginLocal', {
      json: { username: 'admin', password: 'admin' }
    }, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });

    const cookies = loginRes.headers['set-cookie'];
    if (!cookies || cookies.length === 0) {
      return res.json({ success: true, data: [], error: 'Login VDP: sem cookies retornados' });
    }
    const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');

    const listRes = await axios.get('https://vendasdiretaspremium.manus.space/api/trpc/vehicles.list?input=%7B%7D', {
      headers: { Cookie: cookieHeader },
      timeout: 10000
    });

    if (!listRes.data || !listRes.data.result || !listRes.data.result.data || !listRes.data.result.data.json) {
      return res.json({ success: true, data: [], error: 'Resposta inesperada do VDP: ' + JSON.stringify(listRes.data).substring(0, 200) });
    }

    const vehicles = listRes.data.result.data.json;
    const mapped = [];
    for (const v of vehicles) {
      let fipePrice = parseFloat(v.fipePrice) || 0;
      if (!fipePrice && v.brand && v.model && v.year) {
        const fipeResult = await fetchFipeValue(v.brand, v.model, v.version || '', v.year);
        if (fipeResult) fipePrice = fipeResult.value;
      }
      mapped.push({
        id: v.id,
        brand: v.brand || '',
        model: v.model || '',
        version: v.version || '',
        year: v.year || '',
        km: v.mileage || 0,
        color: v.color || '',
        image: v.coverPhotoUrl || (v.photos && v.photos.length > 0 ? v.photos[0] : null),
        price: parseFloat(v.purchasePrice) || 0,
        fipe_price: fipePrice,
        total_costs: parseFloat(v.totalCosts) || 0,
        fuel: v.fuel || '',
        transmission: v.transmission || '',
        city: v.city || '',
        status: v.status || 'em_estoque',
        purchase_date: v.purchaseDate || null,
        photos: v.photos || []
      });
    }
    // Filtrar veiculos ocultos
    try {
      const { pool } = require('../services/db');
      const hiddenRes = await pool.query('SELECT vehicle_id FROM hidden_vehicles');
      const hiddenIds = hiddenRes.rows.map(r => r.vehicle_id);
      const filtered = mapped.filter(v => !hiddenIds.includes(v.id));
      res.json({ success: true, data: filtered });
    } catch(dbErr) {
      res.json({ success: true, data: mapped });
    }
  } catch (err) {
    console.error('VDP fetch error:', err.message);
    res.json({ success: true, data: [], error: err.message });
  }
});

router.get('/stock-detail/:id', async (req, res) => {
  try {
    const vId = parseInt(req.params.id);
    const loginRes = await axios.post('https://vendasdiretaspremium.manus.space/api/trpc/auth.loginLocal', {
      json: { username: 'admin', password: 'admin' }
    }, { timeout: 10000, headers: { 'Content-Type': 'application/json' } });
    const cookies = loginRes.headers['set-cookie'];
    const cookieHeader = cookies ? cookies.map(c => c.split(';')[0]).join('; ') : '';

    const input = encodeURIComponent(JSON.stringify({ json: { id: vId } }));
    const [vRes, cRes] = await Promise.all([
      axios.get('https://vendasdiretaspremium.manus.space/api/trpc/vehicles.getById?input=' + input, { headers: { Cookie: cookieHeader }, timeout: 10000 }),
      axios.get('https://vendasdiretaspremium.manus.space/api/trpc/costs.list?input=' + encodeURIComponent(JSON.stringify({ json: { vehicleId: vId } })), { headers: { Cookie: cookieHeader }, timeout: 10000 })
    ]);

    const detail = vRes.data.result.data.json;
    const costs = cRes.data.result.data.json;

    // Se não tem FIPE do VDP, consultar via Parallelum
    let fipe = detail.fipe || null;
    if (!fipe && detail.vehicle) {
      const v = detail.vehicle;
      const fipeResult = await fetchFipeValue(v.brand, v.model, v.version || '', v.year);
      if (fipeResult) {
        fipe = { fipePrice: String(fipeResult.value), fipeCode: fipeResult.fipeCode, modelName: fipeResult.model, referenceMonth: fipeResult.reference };
      }
    }

    res.json({ success: true, data: { ...detail, fipe, costs } });
  } catch (err) {
    res.json({ success: false, error: err.message });
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
    const costId = parseInt(req.params.id);
    const loginRes = await axios.post('https://vendasdiretaspremium.manus.space/api/trpc/auth.loginLocal', {
      json: { username: 'admin', password: 'admin' }
    }, { timeout: 10000, headers: { 'Content-Type': 'application/json' } });
    const cookies = loginRes.headers['set-cookie'];
    const cookieHeader = cookies ? cookies.map(c => c.split(';')[0]).join('; ') : '';

    await axios.post('https://vendasdiretaspremium.manus.space/api/trpc/costs.delete', {
      json: { id: costId }
    }, { headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' }, timeout: 10000 });

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/stock-cost', async (req, res) => {
  try {
    const { vehicleId, category, description, amount } = req.body;
    const catMap = { 'Frete':'frete', 'Reparo':'reparo', 'Revisão':'revisao', 'Documentação':'documentacao', 'Limpeza/Estética':'limpeza', 'IPVA':'outros', 'Gasolina':'outros', 'Pedágio':'outros', 'Comissão':'outros', 'Uber':'outros', '%%':'outros', 'Outros':'outros' };
    const cat = catMap[category] || 'outros';

    const loginRes = await axios.post('https://vendasdiretaspremium.manus.space/api/trpc/auth.loginLocal', {
      json: { username: 'admin', password: 'admin' }
    }, { timeout: 10000, headers: { 'Content-Type': 'application/json' } });
    const cookies = loginRes.headers['set-cookie'];
    const cookieHeader = cookies ? cookies.map(c => c.split(';')[0]).join('; ') : '';

    await axios.post('https://vendasdiretaspremium.manus.space/api/trpc/costs.add', {
      json: { vehicleId, category: cat, description: description || category, amount: parseFloat(amount), date: new Date().toISOString().split('T')[0] }
    }, { headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' }, timeout: 10000 });

    res.json({ success: true });
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

          // Verificar se já existe (evitar duplicata)
          const exists = await pool.query(
            'SELECT id FROM purchases WHERE brand=$1 AND model=$2 AND year=$3 AND price=$4',
            [brand, model, String(year), price]
          );
          if (exists.rows.length > 0) continue;

          await pool.query(
            'INSERT INTO purchases (brand, model, version, year, km, color, price, status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [brand, model, version, String(year), km, color, price, 'disponivel', 'Importado de: ' + account.name]
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

router.get('/admin/bids', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const result = await pool.query('SELECT * FROM bids ORDER BY created_at DESC LIMIT 100');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.get('/admin/user/:id/profile', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const userId = parseInt(req.params.id);
    const userRes = await pool.query('SELECT id, name, email, phone, cpf, approved, created_at FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return res.json({ success: false, error: 'Usuário não encontrado' });
    const bidsRes = await pool.query('SELECT * FROM bids WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    res.json({ success: true, data: { user: userRes.rows[0], bids: bidsRes.rows } });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.get('/my-bids', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.json({ success: true, data: [] });
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'lance-prime-secret-2024');
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
    const testData = await fipeGet('/carros/marcas');
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

