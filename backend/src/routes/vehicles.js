const express = require('express');
const router = express.Router();
const axios = require('axios');
const { PDFDocument, rgb } = require('pdf-lib');
const dealers = require('../services/dealers');
const { requireApproved } = require('./auth');

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
  let weightedMatches = 0;
  for (const w of wordsA) {
    if (w.length > 2 && wordsB.some(wb => wb.includes(w) || w.includes(wb))) {
      matches++;
      // Palavras com numeros (motorizacao, cilindrada) tem peso maior
      if (/\d/.test(w)) weightedMatches += 2;
      else weightedMatches += 1;
    }
  }
  const totalWeight = wordsA.reduce((acc, w) => acc + (/\d/.test(w) ? 2 : 1), 0);
  return weightedMatches / Math.max(totalWeight, wordsB.length);
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
      const result = { value: valorNum, model: data.Modelo, year: data.AnoModelo, reference: data.MesReferencia, fipeCode: data.CodigoFipe, matchScore: bestScore.toFixed(2) };
      fipeCache.set(cacheKey, result);
      return result;
    } catch (err) {
      continue;
    }
  }
  fipeCache.set(cacheKey, null);
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
      const start = new Date(e.start_date_display);
      if (finish < now) return false;
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
    const { value } = req.body;
    if (!value) return res.status(400).json({ success: false, error: 'Valor obrigatório' });

    // Remove spread antes de enviar ao Dealers Club
    const realValue = removeSpread(value);
    const result = await dealers.placeBid(parseInt(req.params.advertisementId), realValue);
    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message;
    res.status(status).json({ success: false, error: message });
  }
});

router.post('/vehicles/:advertisementId/auto-bid', requireApproved, async (req, res) => {
  try {
    const { maxValue, tiebreaker } = req.body;
    if (!maxValue) return res.status(400).json({ success: false, error: 'Valor máximo obrigatório' });

    // Remove spread antes de enviar ao Dealers Club
    const realMaxValue = removeSpread(maxValue);
    const result = await dealers.placeAutoBid(parseInt(req.params.advertisementId), realMaxValue, tiebreaker || false);
    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message;
    res.status(status).json({ success: false, error: message });
  }
});

router.post('/vehicles/:advertisementId/buy-now', requireApproved, async (req, res) => {
  try {
    const { value } = req.body;
    if (!value) return res.status(400).json({ success: false, error: 'Valor obrigatório' });

    // Remove spread antes de enviar ao Dealers Club
    const realValue = removeSpread(value);
    const result = await dealers.buyNow(parseInt(req.params.advertisementId), realValue);
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
    const loginRes = await axios.post('https://lanceprimecars.com/api/trpc/auth.loginLocal', {
      json: { username: 'admin', password: 'admin' }
    }, { withCredentials: true });

    const cookies = loginRes.headers['set-cookie'];
    const cookieHeader = cookies ? cookies.map(c => c.split(';')[0]).join('; ') : '';

    const listRes = await axios.get('https://lanceprimecars.com/api/trpc/vehicles.list?input=%7B%7D', {
      headers: { Cookie: cookieHeader }
    });

    const vehicles = listRes.data.result.data.json;
    const mapped = vehicles.map(v => {
      let coverImg = v.coverPhotoUrl || (v.photos && v.photos.length > 0 ? v.photos[0] : null);
      if (coverImg && coverImg.startsWith('/api/')) {
        coverImg = 'https://lanceprimecars.com' + coverImg;
      }
      return {
        id: v.id,
        brand: v.brand || '',
        model: v.model || '',
        version: v.version || '',
        year: v.year || '',
        km: v.mileage || 0,
        color: v.color || '',
        image: coverImg,
        price: parseFloat(v.purchasePrice) || 0,
        fipe_price: parseFloat(v.fipePrice) || 0,
        total_costs: parseFloat(v.totalCosts) || 0,
        fuel: v.fuel || '',
        transmission: v.transmission || '',
        city: v.city || '',
        status: v.status || '',
        purchase_date: v.purchaseDate || null,
        photos: (v.photos || []).map(p => p.startsWith('/api/') ? 'https://lanceprimecars.com' + p : p)
      };
    });
    res.json({ success: true, data: mapped });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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

router.get('/my-offers', async (req, res) => {
  try {
    const data = await dealers.getMyOffers();
    res.json({ success: true, data: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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

