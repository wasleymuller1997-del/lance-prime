const express = require('express');
const router = express.Router();
const axios = require('axios');
const dealers = require('../services/dealers');
const { authMiddleware, adminOnly } = require('./auth');

const FIPE_BASE = 'https://parallelum.com.br/fipe/api/v1';
const fipeCache = new Map();

function normalize(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const wordsA = na.split(/\s+/);
  const wordsB = nb.split(/\s+/);
  let matches = 0;
  for (const w of wordsA) {
    if (w.length > 2 && wordsB.some(wb => wb.includes(w) || w.includes(wb))) matches++;
  }
  return matches / Math.max(wordsA.length, wordsB.length);
}

async function fetchFipeValue(brand, model, version, year) {
  const cacheKey = `${brand}|${model}|${version}|${year}`;
  if (fipeCache.has(cacheKey)) return fipeCache.get(cacheKey);

  const categories = ['carros', 'motos'];
  for (const categoryType of categories) {
    try {
      const marcasRes = await axios.get(`${FIPE_BASE}/${categoryType}/marcas`);
      const marcas = marcasRes.data;
      const brandNorm = normalize(brand);
      const marca = marcas.find(m => normalize(m.nome) === brandNorm)
        || marcas.find(m => normalize(m.nome).includes(brandNorm) || brandNorm.includes(normalize(m.nome)));
      if (!marca) continue;

      const modelosRes = await axios.get(`${FIPE_BASE}/${categoryType}/marcas/${marca.codigo}/modelos`);
      const modelos = modelosRes.data.modelos;
      const searchStr = `${model} ${version}`.trim();
      const modelNorm = normalize(model);

      let bestModel = null;
      let bestScore = 0;
      for (const m of modelos) {
        const mNorm = normalize(m.nome);
        if (!mNorm.includes(modelNorm)) continue;
        const score = similarity(m.nome, searchStr);
        if (score > bestScore) { bestScore = score; bestModel = m; }
      }
      if (!bestModel) {
        for (const m of modelos) {
          const score = similarity(m.nome, searchStr);
          if (score > bestScore) { bestScore = score; bestModel = m; }
        }
      }
      if (!bestModel || bestScore < 0.2) {
        bestModel = modelos.find(m => normalize(m.nome).includes(modelNorm));
        if (!bestModel) continue;
      }

      const anosRes = await axios.get(`${FIPE_BASE}/${categoryType}/marcas/${marca.codigo}/modelos/${bestModel.codigo}/anos`);
      const anos = anosRes.data;
      const yearStr = String(year);
      let ano = anos.find(a => a.codigo.startsWith(yearStr + '-'));
      if (!ano) ano = anos.find(a => a.nome.includes(yearStr));
      if (!ano) {
        const sorted = anos.filter(a => !a.codigo.startsWith('32000'))
          .sort((a, b) => Math.abs(parseInt(a.codigo) - year) - Math.abs(parseInt(b.codigo) - year));
        ano = sorted[0] || anos[0];
      }
      if (!ano) continue;

      const valorRes = await axios.get(`${FIPE_BASE}/${categoryType}/marcas/${marca.codigo}/modelos/${bestModel.codigo}/anos/${ano.codigo}`);
      const data = valorRes.data;
      const valorNum = parseFloat(data.Valor.replace('R$ ', '').replace(/\./g, '').replace(',', '.'));
      const result = { value: valorNum, model: data.Modelo, year: data.AnoModelo, reference: data.MesReferencia };
      fipeCache.set(cacheKey, result);
      return result;
    } catch (err) {
      continue;
    }
  }
  fipeCache.set(cacheKey, null);
  return null;
}


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
      const start = new Date(e.start_date_display);
      if (finish < now) return false;
      const nameLower = e.name.toLowerCase();
      if (nameLower.includes('cancelado') || nameLower.includes('vinculos')) return false;
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
  if (!description) return { location: null, comitente: null, plate: null };
  let location = null;
  let comitente = null;
  let plate = null;
  const locMatch = description.match(/LOCALIZA[ÇC][ÃA]O:\s*([^\/\n]+)/i);
  if (locMatch) location = locMatch[1].trim();
  const comMatch = description.match(/COMITENTE:\s*([^\/\n]+)/i);
  if (comMatch) comitente = comMatch[1].trim();
  const plateMatch = description.match(/PLACA[:\s]+([A-Z]{3}[\-\s]?\d[A-Z0-9]\d{2})/i);
  if (plateMatch) plate = plateMatch[1].trim().toUpperCase();
  return { location, comitente, plate };
}

router.get('/events/:eventId/vehicles', async (req, res) => {
  try {
    const vehicles = await dealers.getEventVehicles(req.params.eventId);
    const mapped = vehicles.map(v => {
      const info = extractInfo(v.vehicle.description);
      return {
        id: v.id,
        vehicle: v.vehicle,
        shop: { name: v.shop.name, city: v.shop.city, state: v.shop.state },
        negotiation: {
          ...v.negotiation
        },
        offers: v.offers,
        offer_actual: v.offer_actual || null,
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

router.post('/vehicles/:advertisementId/bid', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { value } = req.body;
    if (!value) return res.status(400).json({ success: false, error: 'Valor obrigatório' });

    const result = await dealers.placeBid(parseInt(req.params.advertisementId), value);
    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message;
    res.status(status).json({ success: false, error: message });
  }
});

router.post('/vehicles/:advertisementId/auto-bid', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { maxValue, tiebreaker } = req.body;
    if (!maxValue) return res.status(400).json({ success: false, error: 'Valor máximo obrigatório' });

    const result = await dealers.placeAutoBid(parseInt(req.params.advertisementId), maxValue, tiebreaker || false);
    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message;
    res.status(status).json({ success: false, error: message });
  }
});

router.post('/vehicles/:advertisementId/buy-now', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { value } = req.body;
    if (!value) return res.status(400).json({ success: false, error: 'Valor obrigatório' });

    const result = await dealers.buyNow(parseInt(req.params.advertisementId), value);

    if (result && (result.success !== false)) {
      try {
        const { pool } = require('../services/db');
        const vehicleData = req.body.vehicle || {};
        const brand = vehicleData.brand_name || vehicleData.brand || '';
        const model = vehicleData.model_name || vehicleData.model || '';
        const version = vehicleData.version_name || vehicleData.version || '';
        const year = vehicleData.model_year || vehicleData.year || '';
        const km = vehicleData.km || 0;
        const color = vehicleData.color || '';
        const photos = vehicleData.photos ? JSON.stringify(vehicleData.photos) : null;
        const plate = vehicleData.plate || null;
        const location = vehicleData.location || null;
        const comitente = vehicleData.comitente || null;

        const existing = await pool.query('SELECT id FROM purchases WHERE dealer_id = $1', [parseInt(req.params.advertisementId)]);
        if (existing.rows.length === 0) {
          await pool.query(
            `INSERT INTO purchases (brand, model, version, year, km, color, price, sell_price, status, dealer_id, plate, location, comitente, photos)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [brand, model, version, year, km, color, value, 0, 'disponivel', parseInt(req.params.advertisementId), plate, location, comitente, photos]
          );
        }
      } catch (dbErr) { console.log('Auto-save to stock failed:', dbErr.message); }
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

router.post('/my-purchases/import', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    let purchases = [];

    try {
      purchases = await dealers.getMyPurchases();
    } catch (e) {}

    if (!purchases || !Array.isArray(purchases) || purchases.length === 0) {
      try {
        const offers = await dealers.getMyOffers();
        if (offers && Array.isArray(offers)) {
          purchases = offers.filter(o => {
            const sit = (o.situation || o.status || '').toLowerCase();
            return sit.includes('ganho') || sit.includes('arrematad') || sit.includes('comprad') || sit.includes('won') || sit === 'approved' || sit === 'finalizado';
          });
        }
      } catch (e) {}
    }

    if (!purchases || purchases.length === 0) {
      return res.json({ success: true, imported: 0, skipped: 0, message: 'Nenhuma compra encontrada' });
    }

    let imported = 0;
    let skipped = 0;

    for (const p of purchases) {
      const vehicle = p.vehicle || p;
      const negotiation = p.negotiation || {};
      const advertisement = p.advertisement || p;

      const dealerId = advertisement.id || p.id || null;

      const existing = await pool.query('SELECT id FROM purchases WHERE dealer_id = $1', [dealerId]);
      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }

      const brand = vehicle.brand_name || vehicle.brand || '';
      const model = vehicle.model_name || vehicle.model || '';
      const version = vehicle.version_name || vehicle.version || '';
      const year = vehicle.model_year || vehicle.year || '';
      const km = vehicle.km || 0;
      const color = vehicle.color || '';
      const price = negotiation.value_actual || negotiation.value || p.value || 0;
      const fuel = vehicle.fuel || '';
      const transmission = vehicle.transmission || vehicle.gearbox || '';
      const doors = vehicle.doors || null;
      const engine = vehicle.engine || vehicle.motor || '';

      const description = vehicle.description || '';
      let plate = null;
      let location = null;
      let comitente = null;
      const plateMatch = description.match(/PLACA[:\s]+([A-Z]{3}[\-\s]?\d[A-Z0-9]\d{2})/i);
      if (plateMatch) plate = plateMatch[1].trim().toUpperCase();
      const locMatch = description.match(/LOCALIZA[ÇC][ÃA]O:\s*([^\/\n]+)/i);
      if (locMatch) location = locMatch[1].trim();
      const comMatch = description.match(/COMITENTE:\s*([^\/\n]+)/i);
      if (comMatch) comitente = comMatch[1].trim();

      let photos = null;
      if (vehicle.image_gallery && vehicle.image_gallery.length > 0) {
        photos = JSON.stringify(vehicle.image_gallery.map(img => img.image || img.thumb));
      }

      await pool.query(
        `INSERT INTO purchases (brand, model, version, year, km, color, price, sell_price, status, notes, dealer_id, plate, location, comitente, photos, fuel, transmission, doors, engine)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [brand, model, version, year, km, color, price, 0, 'disponivel',
         description, dealerId, plate, location, comitente, photos, fuel, transmission, doors, engine]
      );
      imported++;
    }

    res.json({ success: true, imported, skipped, total: purchases.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/my-purchases', async (req, res) => {
  try {
    const { pool } = require('../services/db');
    const { brand, model, version, year, km, color, price, sell_price, status, notes, dealer_id, plate, location, comitente, photos, fuel, transmission, doors, engine } = req.body;
    const result = await pool.query(
      `INSERT INTO purchases (brand, model, version, year, km, color, price, sell_price, status, notes, dealer_id, plate, location, comitente, photos, fuel, transmission, doors, engine)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [brand, model, version, year, km || 0, color, price || 0, sell_price || 0, status || 'disponivel', notes, dealer_id || null, plate || null, location || null, comitente || null, photos || null, fuel || null, transmission || null, doors || null, engine || null]
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

router.get('/my-offers', async (req, res) => {
  try {
    const data = await dealers.getMyOffers();
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/my-purchases/debug', async (req, res) => {
  try {
    await dealers.ensureAuth();
    const shopId = process.env.DEALERS_SHOP_ID;
    const userId = process.env.DEALERS_USER_ID;
    const whitelabelId = process.env.DEALERS_WHITELABEL_ID;
    const routes = [
      `/v1/auditorio/minhas-compras/${shopId}`,
      `/v1/auditorio/minhas-compras/${userId}`,
      `/v1/minhas-compras/${shopId}`,
      `/v1/minhas-compras/${userId}`,
      `/v1/compras/${shopId}`,
      `/v1/compras/${userId}`,
      `/v1/auditorio/compras/${shopId}`,
      `/v1/auditorio/compras/${userId}`,
      `/v1/auditorio/minhas-ofertas/${shopId}`,
      `/v1/auditorio/minhas-ofertas/${userId}`,
      `/v1/shop/${shopId}/compras`,
      `/v1/auditorio/historico/${shopId}`,
      `/v1/auditorio/historico/${userId}`,
      `/v1/auditorio/arrematados/${shopId}`,
      `/v1/auditorio/arrematados/${userId}`,
      `/v1/auditorio/ganhos/${shopId}`,
      `/v1/auditorio/ganhos/${userId}`,
      `/v1/auditorio/vencidos/${shopId}`,
      `/v1/auditorio/vencidos/${userId}`,
      `/v1/publica/minhas-compras/${shopId}`,
      `/v1/publica/minhas-compras/${userId}`
    ];

    const results = {};
    for (const route of routes) {
      try {
        const r = await dealers.api.get(route);
        results[route] = { status: r.status, hasData: !!(r.data && (r.data.results || r.data.data || (Array.isArray(r.data) && r.data.length > 0))), preview: JSON.stringify(r.data).substring(0, 200) };
      } catch (err) {
        results[route] = { status: err.response?.status || 'error' };
      }
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
      res.json({ success: false, data: null });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
