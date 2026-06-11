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
const { pool } = require('../services/db');
const { requireAdmin } = require('./auth');
const { PROMPTS, DEFAULTS, fillPrompt } = require('../services/marketingPrompts');

// Lazy load do SDK — NUNCA derrubar o servidor inteiro se o SDK ou a env var
// tiverem problema. Tudo isolado dentro de try-catch.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MARKETING_MODEL || 'claude-opus-4-8';
let anthropic = null;
try {
  if (ANTHROPIC_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
    console.log('[marketing] Claude API pronta (modelo: ' + MODEL + ')');
  } else {
    console.warn('[marketing] ANTHROPIC_API_KEY nao configurada. Geracao automatica indisponivel — modo "Copiar prompt" continua funcionando.');
  }
} catch (e) {
  console.warn('[marketing] Falha carregando @anthropic-ai/sdk:', e.message, '— modo "Copiar prompt" continua funcionando.');
  anthropic = null;
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
 * Modo GRATIS: monta o prompt ja preenchido e devolve, sem chamar Claude.
 * O lojista copia e cola em claude.ai ou chatgpt.com (tier free) enquanto
 * nao ativar a ANTHROPIC_API_KEY. Mesma logica de validacao do generate.
 */
router.post('/marketing/preview-prompt', requireAdmin, (req, res) => {
  try {
    const { type, vars } = req.body || {};
    if (!type || !PROMPTS[type]) {
      return res.status(400).json({ success: false, error: 'Tipo de prompt invalido' });
    }
    const tpl = PROMPTS[type];
    const merged = Object.assign({}, DEFAULTS, vars || {});
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
    const userPrompt = fillPrompt(tpl.user, merged);
    // Devolve system + user concatenados (pronto pra colar em qualquer chat)
    const fullPrompt = '=== CONTEXTO ===\n' + tpl.system + '\n\n=== TAREFA ===\n' + userPrompt;
    res.json({ success: true, prompt: fullPrompt, label: tpl.label });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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
