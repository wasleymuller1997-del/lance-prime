/**
 * Rotas de Marketing — aba "Marketing" do admin.
 *
 * Tudo aqui requer admin (requireAdmin do auth.js). Chamadas batem na
 * API do Claude (Anthropic) com os prompts em services/marketingPrompts.js.
 *
 * Cada geracao fica salva em marketing_generations pro lojista nao pagar
 * a mesma coisa duas vezes — historico fica na aba.
 */

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../services/db');
const { requireAdmin } = require('./auth');
const { PROMPTS, DEFAULTS, fillPrompt } = require('../services/marketingPrompts');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MARKETING_MODEL || 'claude-opus-4-8'; // melhor pra texto longo/criativo
let anthropic = null;
if (ANTHROPIC_KEY) {
  anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
} else {
  console.warn('[marketing] ANTHROPIC_API_KEY nao configurada. Aba Marketing ficara indisponivel ate setar a variavel no Render.');
}

// Lista os tipos disponiveis (pra o frontend popular os botoes)
router.get('/marketing/types', requireAdmin, (req, res) => {
  const types = Object.keys(PROMPTS).map(key => ({ key, label: PROMPTS[key].label }));
  res.json({ success: true, types, model: MODEL, ready: !!anthropic });
});

// Defaults usados nos formularios (brand, handle, audience padrao)
router.get('/marketing/defaults', requireAdmin, (req, res) => {
  res.json({ success: true, defaults: DEFAULTS });
});

// Historico das geracoes (paginado simples)
router.get('/marketing/history', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '40'), 100);
    const r = await pool.query(
      `SELECT id, type, label, params, output, created_at
       FROM marketing_generations
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Le 1 item especifico do historico (pra ver de novo sem regerar)
router.get('/marketing/history/:id', requireAdmin, async (req, res) => {
  const r = await pool.query('SELECT * FROM marketing_generations WHERE id = $1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ success: false, error: 'Nao encontrado' });
  res.json({ success: true, data: r.rows[0] });
});

router.delete('/marketing/history/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM marketing_generations WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

/**
 * Gera conteudo. Body:
 *   { type: 'plano_crescimento'|..., vars: { brand, handle, audience, oferta, ideia, conteudo } }
 *
 * Cada tipo de prompt usa vars diferentes. O frontend manda so o que precisar;
 * faltantes caem nos DEFAULTS.
 */
router.post('/marketing/generate', requireAdmin, async (req, res) => {
  if (!anthropic) {
    return res.status(503).json({
      success: false,
      error: 'API do Claude nao configurada. Adicione ANTHROPIC_API_KEY nas variaveis de ambiente do Render.'
    });
  }
  try {
    const { type, vars } = req.body || {};
    if (!type || !PROMPTS[type]) {
      return res.status(400).json({ success: false, error: 'Tipo de prompt invalido' });
    }
    const tpl = PROMPTS[type];
    const merged = Object.assign({}, DEFAULTS, vars || {});
    const userPrompt = fillPrompt(tpl.user, merged);

    // Validacao: tipos que precisam de vars especificas devem ter elas preenchidas
    const required = {
      reel_roteiro: ['ideia'],
      otimizar_conteudo: ['conteudo'],
      conteudo_vendas: ['oferta'],
      reaproveitar: ['conteudo'],
    };
    const missing = (required[type] || []).filter(k => !merged[k] || !String(merged[k]).trim());
    if (missing.length) {
      return res.status(400).json({
        success: false,
        error: 'Campos obrigatorios faltando: ' + missing.join(', ')
      });
    }

    // Chama o Claude
    const start = Date.now();
    const completion = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: tpl.system,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const elapsed = Date.now() - start;
    const text = (completion.content || []).map(c => c.text || '').join('\n').trim();

    // Salva no historico
    const r = await pool.query(
      `INSERT INTO marketing_generations (type, label, params, output, model, tokens_in, tokens_out, ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
      [
        type,
        tpl.label,
        JSON.stringify(merged),
        text,
        MODEL,
        completion.usage ? completion.usage.input_tokens : null,
        completion.usage ? completion.usage.output_tokens : null,
        elapsed,
      ]
    );
    res.json({
      success: true,
      id: r.rows[0].id,
      output: text,
      model: MODEL,
      created_at: r.rows[0].created_at,
      usage: completion.usage || null,
      ms: elapsed,
    });
  } catch (err) {
    console.error('[marketing] generate error:', err.message);
    const code = err.status || 500;
    res.status(code).json({ success: false, error: err.message });
  }
});

module.exports = router;
