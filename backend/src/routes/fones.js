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
// Sonnet por padrão: leitura de serial precisa ser EXATA, e o modelo maior
// erra bem menos caractere em foto de etiqueta. Dá pra trocar via env.
const SCAN_MODEL = process.env.FONES_SCAN_MODEL || 'claude-sonnet-5';

function parseImage(image) {
  let media = 'image/jpeg', data = image;
  const m = String(image).match(/^data:(image\/[\w.+-]+);base64,(.*)$/);
  if (m) { media = m[1]; data = m[2]; }
  return { type: 'image', source: { type: 'base64', media_type: media, data } };
}

router.post('/fones/scan', async (req, res) => {
  try {
    if (!anthropic) {
      return res.status(503).json({ success: false, error: 'Leitura por IA indisponível (sem ANTHROPIC_API_KEY)' });
    }
    let { image, images } = req.body || {};
    if (!Array.isArray(images)) images = image ? [image] : [];
    images = images.filter((i) => typeof i === 'string' && i.length).slice(0, 3);
    if (!images.length) return res.status(400).json({ success: false, error: 'imagem ausente' });
    if (images.some((i) => i.length > 6000000)) return res.status(413).json({ success: false, error: 'imagem muito grande' });

    const completion = await anthropic.messages.create({
      model: SCAN_MODEL,
      max_tokens: 80,
      system: 'Você TRANSCREVE o SERIAL NUMBER na etiqueta/caixa de um fone de ouvido (AirPods, JBL, etc). ' +
        'Na etiqueta Apple ele aparece após "(S) Serial No." — um código alfanumérico de 10 a 14 caracteres ' +
        '(ex.: HRX5TQHY9C). O texto pode estar na vertical ou de cabeça pra baixo. Pode haver mais de uma ' +
        'imagem da MESMA etiqueta (quadro inteiro e recorte ampliado) — use as duas pra confirmar. ' +
        'NÃO confunda com o modelo (ex.: A3055), o part number (ex.: MXP93BE/A) nem o UPC/EAN (só dígitos). ' +
        'Transcreva EXATAMENTE os caracteres visíveis — NUNCA chute um caractere que não esteja nítido. ' +
        'Responda APENAS com um JSON: {"serial":"HRX5TQHY9C","sure":true}. ' +
        '"sure" só pode ser true se TODOS os caracteres estiverem nítidos e sem nenhuma dúvida ' +
        '(atenção a 0/O, 1/I/L, 5/S, 8/B, 2/Z). Na dúvida em qualquer caractere: "sure":false. ' +
        'Se não der pra ler: {"serial":null,"sure":false}. Nada além do JSON.',
      messages: [{
        role: 'user',
        content: [
          ...images.map(parseImage),
          { type: 'text', text: 'Qual o serial number? Só o JSON.' },
        ],
      }],
    });
    const text = (completion.content || []).map((c) => c.text || '').join(' ').trim();
    let out = null;
    try { out = JSON.parse((text.match(/\{[\s\S]*\}/) || [text])[0]); } catch (e) { out = null; }
    let serial = out && out.serial ? String(out.serial).toUpperCase().replace(/[^A-Z0-9\-\/]/g, '') : null;
    if (serial && serial.length < 6) serial = null;
    res.json({ success: true, serial: serial || null, sure: !!(out && out.sure && serial), raw: text });
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
