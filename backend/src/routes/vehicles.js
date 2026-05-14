const express = require('express');
const router = express.Router();
const axios = require('axios');
const dealers = require('../services/dealers');

const MARGIN = parseFloat(process.env.MARGIN_PERCENT) / 100;

function addMargin(value) {
  return Math.ceil(value * (1 + MARGIN));
}

function removeMargin(valueWithMargin) {
  return Math.floor(valueWithMargin / (1 + MARGIN));
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
    res.json({ success: true, data: events });
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

router.get('/events/:eventId/vehicles', async (req, res) => {
  try {
    const vehicles = await dealers.getEventVehicles(req.params.eventId);
    const withMargin = vehicles.map(v => ({
      id: v.id,
      vehicle: v.vehicle,
      shop: { name: v.shop.name, city: v.shop.city, state: v.shop.state },
      negotiation: {
        ...v.negotiation,
        value_actual: addMargin(v.negotiation.value_actual),
        initial_price_dispute: addMargin(v.negotiation.initial_price_dispute),
        immediate_sale_price: v.negotiation.immediate_sale_price ? addMargin(v.negotiation.immediate_sale_price) : null,
        increment: v.negotiation.increment
      },
      offers: v.offers,
      offer_actual: v.offer_actual ? {
        ...v.offer_actual,
        price: addMargin(v.offer_actual.price)
      } : null,
      situation: v.situation,
      is_favorite: v.is_favorite
    }));
    res.json({ success: true, data: withMargin });
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

router.post('/vehicles/:advertisementId/bid', async (req, res) => {
  try {
    const { value } = req.body;
    if (!value) return res.status(400).json({ success: false, error: 'Valor obrigatório' });

    const realValue = removeMargin(value);
    const result = await dealers.placeBid(parseInt(req.params.advertisementId), realValue);
    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message;
    res.status(status).json({ success: false, error: message });
  }
});

router.post('/vehicles/:advertisementId/auto-bid', async (req, res) => {
  try {
    const { maxValue, tiebreaker } = req.body;
    if (!maxValue) return res.status(400).json({ success: false, error: 'Valor máximo obrigatório' });

    const realValue = removeMargin(maxValue);
    const result = await dealers.placeAutoBid(parseInt(req.params.advertisementId), realValue, tiebreaker || false);
    res.json({ success: true, data: result });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message;
    res.status(status).json({ success: false, error: message });
  }
});

router.post('/vehicles/:advertisementId/buy-now', async (req, res) => {
  try {
    const { value } = req.body;
    if (!value) return res.status(400).json({ success: false, error: 'Valor obrigatório' });

    const realValue = removeMargin(value);
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
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, '../../data/purchases.json');
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      res.json({ success: true, data: data });
    } else {
      res.json({ success: true, data: [] });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/my-purchases', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, '../../data/purchases.json');
    let data = [];
    if (fs.existsSync(filePath)) {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    const newItem = { id: Date.now(), ...req.body, created_at: new Date().toISOString() };
    data.push(newItem);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    res.json({ success: true, data: newItem });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/my-purchases/:id', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, '../../data/purchases.json');
    let data = [];
    if (fs.existsSync(filePath)) {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    data = data.filter(item => item.id !== parseInt(req.params.id));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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

module.exports = router;
