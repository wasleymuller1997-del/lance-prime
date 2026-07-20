// Leitor de serial number dos fones (/fones): leitura por IA no backend.
// A visão da Claude lê a etiqueta inteira (texto torto, desfocado, na vertical)
// e devolve só o serial — muito mais confiável que OCR no navegador.
const express = require('express');

const router = express.Router();

let anthropic = null;
let anthropicErr = null;
try {
  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
} catch (e) { anthropic = null; anthropicErr = e.message; }
const SCAN_MODEL = process.env.FONES_SCAN_MODEL || 'claude-haiku-4-5-20251001';

router.post('/fones/scan', async (req, res) => {
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
      system: 'Você lê o SERIAL NUMBER na etiqueta/caixa de um fone de ouvido (AirPods, JBL, etc). ' +
        'Na etiqueta Apple ele aparece após "(S) Serial No." — um código alfanumérico de 10 a 14 caracteres ' +
        '(ex.: HRX5TQHY9C). O texto pode estar na vertical ou de cabeça pra baixo. ' +
        'NÃO confunda com o modelo (ex.: A3055), o part number (ex.: MXP93BE/A) nem o UPC/EAN (só dígitos). ' +
        'Responda APENAS com um JSON: {"serial":"HRX5TQHY9C"} — ou {"serial":null} se não der pra ler. Nada além do JSON.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: media, data: data } },
          { type: 'text', text: 'Qual o serial number? Só o JSON.' },
        ],
      }],
    });
    const text = (completion.content || []).map((c) => c.text || '').join(' ').trim();
    let out = null;
    try { out = JSON.parse((text.match(/\{[\s\S]*\}/) || [text])[0]); } catch (e) { out = null; }
    let serial = out && out.serial ? String(out.serial).toUpperCase().replace(/[^A-Z0-9\-\/]/g, '') : null;
    if (serial && serial.length < 6) serial = null;
    res.json({ success: true, serial: serial || null, raw: text });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/fones/scan-status', (req, res) => {
  const k = process.env.ANTHROPIC_API_KEY || '';
  res.json({
    ready: !!anthropic,
    hasKey: !!k,
    model: SCAN_MODEL,
    sdkError: anthropicErr,
  });
});

module.exports = router;
