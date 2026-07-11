const express = require('express');
const router = express.Router();

// Tradutor de viagem (/tradutor): proxy do endpoint público do Google Translate
// (gtx, sem chave). Fica no backend pra não depender de CORS no celular e pra
// poder trocar de provedor depois sem mexer no app.

// Cache em memória: frases repetidas ("hola", "gracias", "quanto custa") não
// batem no Google de novo. Limitado pra não comer a RAM do Render free.
const cache = new Map();
const CACHE_MAX = 500;

function langOk(l) {
  return typeof l === 'string' && /^[a-z]{2}(-[a-z]{2,4})?$/i.test(l);
}

router.post('/translate', async (req, res) => {
  try {
    const { text, from, to } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ success: false, error: 'Texto vazio.' });
    }
    if (text.length > 1500) {
      return res.status(400).json({ success: false, error: 'Texto muito longo (máx 1500 caracteres).' });
    }
    const sl = langOk(from) ? from : 'auto';
    const tl = langOk(to) ? to : 'pt';

    const key = sl + '|' + tl + '|' + text.trim().toLowerCase();
    if (cache.has(key)) {
      return res.json({ success: true, translated: cache.get(key), cached: true });
    }

    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' +
      encodeURIComponent(sl) + '&tl=' + encodeURIComponent(tl) + '&dt=t&q=' + encodeURIComponent(text);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('Tradutor respondeu HTTP ' + r.status);
    const data = await r.json();
    const translated = (Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [])
      .map((p) => (p && p[0] ? p[0] : ''))
      .join('')
      .trim();
    if (!translated) throw new Error('Tradução veio vazia.');

    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, translated);
    res.json({ success: true, translated });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message || 'Falha na tradução.' });
  }
});

module.exports = router;
