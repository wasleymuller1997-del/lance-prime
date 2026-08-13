// Loja WM Soluções Tecnológicas (/wm/loja + /wm/admin): venda de fones e
// eletrônicos. Isolado igual aos outros apps (figurinhas, robocrypto): cria
// as próprias tabelas (wm_*) no 1º uso e, se falhar ao carregar, o server.js
// segue de pé.
//
// Modelo de estoque: cada produto tem uma ORIGEM —
//   'proprio'     = item em mãos (fones, base da operação); venda baixa o estoque.
//   'fornecedor'  = catálogo do fornecedor de pronta entrega; o dono busca o
//                   item quando vende, então fica disponível enquanto ativo,
//                   mesmo sem quantidade em mãos.

const express = require('express');
const router = express.Router();
const { pool } = require('../services/db');
const { requireAdmin } = require('./auth');

// ---- Criação preguiçosa das tabelas (idempotente) -------------------------
let ready = null;
function ensureTables() {
  if (!ready) {
    ready = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS wm_products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          category VARCHAR(100) DEFAULT 'Outros',
          description TEXT,
          price NUMERIC NOT NULL DEFAULT 0,
          cost NUMERIC DEFAULT 0,
          stock INTEGER DEFAULT 0,
          origin VARCHAR(20) DEFAULT 'proprio',
          image TEXT,
          status VARCHAR(20) DEFAULT 'ativo',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      // Snapshot do produto na venda: se o produto for editado/apagado depois,
      // o histórico financeiro continua íntegro.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS wm_sales (
          id SERIAL PRIMARY KEY,
          product_id INTEGER,
          product_name VARCHAR(255) NOT NULL,
          origin VARCHAR(20),
          qty INTEGER NOT NULL DEFAULT 1,
          unit_price NUMERIC NOT NULL DEFAULT 0,
          unit_cost NUMERIC DEFAULT 0,
          buyer_name VARCHAR(255),
          buyer_phone VARCHAR(50),
          notes TEXT,
          sold_at DATE DEFAULT NOW(),
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_wm_sales_product ON wm_sales(product_id)`).catch(() => {});
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const cleanOrigin = (o) => (o === 'fornecedor' ? 'fornecedor' : 'proprio');
const cleanStatus = (s) => (s === 'pausado' ? 'pausado' : 'ativo');

// ---- Público: vitrine -----------------------------------------------------
// Não expõe custo nem estoque exato — só o que o cliente precisa ver.
// 'proprio' aparece enquanto tiver unidade; 'fornecedor' aparece enquanto ativo.
router.get('/wm/products', async (req, res) => {
  try {
    await ensureTables();
    const r = await pool.query(`
      SELECT id, name, category, description, price, origin, image
      FROM wm_products
      WHERE status = 'ativo' AND (origin = 'fornecedor' OR stock > 0)
      ORDER BY (origin = 'proprio') DESC, created_at DESC
    `);
    res.json({ success: true, products: r.rows });
  } catch (e) {
    console.error('[wmstore] products:', e.message);
    res.status(500).json({ success: false, error: 'Erro ao carregar produtos' });
  }
});

// ---- Admin: produtos ------------------------------------------------------
router.get('/wm/admin/products', requireAdmin, async (req, res) => {
  try {
    await ensureTables();
    const r = await pool.query(`SELECT * FROM wm_products ORDER BY (origin = 'proprio') DESC, created_at DESC`);
    res.json({ success: true, products: r.rows });
  } catch (e) {
    console.error('[wmstore] admin products:', e.message);
    res.status(500).json({ success: false, error: 'Erro ao carregar produtos' });
  }
});

router.post('/wm/admin/products', requireAdmin, async (req, res) => {
  try {
    await ensureTables();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Nome é obrigatório' });
    if (b.image && String(b.image).length > 900000) {
      return res.status(413).json({ success: false, error: 'Foto muito grande — tente de novo' });
    }
    const r = await pool.query(
      `INSERT INTO wm_products (name, category, description, price, cost, stock, origin, image, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        name.slice(0, 255),
        String(b.category || 'Outros').trim().slice(0, 100) || 'Outros',
        String(b.description || '').slice(0, 2000),
        num(b.price), num(b.cost), Math.max(0, Math.round(num(b.stock))),
        cleanOrigin(b.origin), b.image || null, cleanStatus(b.status),
      ]
    );
    res.json({ success: true, product: r.rows[0] });
  } catch (e) {
    console.error('[wmstore] create:', e.message);
    res.status(500).json({ success: false, error: 'Erro ao salvar produto' });
  }
});

router.put('/wm/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    await ensureTables();
    const id = num(req.params.id);
    const b = req.body || {};
    if (b.image && String(b.image).length > 900000) {
      return res.status(413).json({ success: false, error: 'Foto muito grande — tente de novo' });
    }
    // Monta o UPDATE só com os campos enviados — o form manda tudo, mas
    // ações rápidas (pausar, +1/-1 estoque) mandam um campo só.
    const map = {
      name: (v) => String(v).trim().slice(0, 255),
      category: (v) => String(v).trim().slice(0, 100) || 'Outros',
      description: (v) => String(v).slice(0, 2000),
      price: (v) => num(v),
      cost: (v) => num(v),
      stock: (v) => Math.max(0, Math.round(num(v))),
      origin: cleanOrigin,
      image: (v) => v || null,
      status: cleanStatus,
    };
    const sets = [], vals = [];
    for (const [k, fn] of Object.entries(map)) {
      if (k in b) { vals.push(fn(b[k])); sets.push(`${k} = $${vals.length}`); }
    }
    if (!sets.length) return res.status(400).json({ success: false, error: 'Nada para atualizar' });
    vals.push(id);
    const r = await pool.query(
      `UPDATE wm_products SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, error: 'Produto não encontrado' });
    res.json({ success: true, product: r.rows[0] });
  } catch (e) {
    console.error('[wmstore] update:', e.message);
    res.status(500).json({ success: false, error: 'Erro ao atualizar produto' });
  }
});

router.delete('/wm/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    await ensureTables();
    await pool.query('DELETE FROM wm_products WHERE id = $1', [num(req.params.id)]);
    res.json({ success: true });
  } catch (e) {
    console.error('[wmstore] delete:', e.message);
    res.status(500).json({ success: false, error: 'Erro ao excluir produto' });
  }
});

// ---- Admin: vendas --------------------------------------------------------
router.post('/wm/admin/products/:id/sale', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTables();
    const id = num(req.params.id);
    const b = req.body || {};
    const qty = Math.max(1, Math.round(num(b.qty, 1)));
    await client.query('BEGIN');
    const p = (await client.query('SELECT * FROM wm_products WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Produto não encontrado' }); }
    if (p.origin === 'proprio' && p.stock < qty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: `Estoque insuficiente (${p.stock} em mãos)` });
    }
    const unitPrice = 'unit_price' in b ? num(b.unit_price) : num(p.price);
    const sale = (await client.query(
      `INSERT INTO wm_sales (product_id, product_name, origin, qty, unit_price, unit_cost, buyer_name, buyer_phone, notes, sold_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10::date, NOW()::date)) RETURNING *`,
      [
        p.id, p.name, p.origin, qty, unitPrice, num(p.cost),
        String(b.buyer_name || '').slice(0, 255) || null,
        String(b.buyer_phone || '').slice(0, 50) || null,
        String(b.notes || '').slice(0, 1000) || null,
        b.sold_at || null,
      ]
    )).rows[0];
    // Baixa o estoque do que está em mãos; item de fornecedor não controla
    // quantidade (o dono busca quando vende), mas se tiver contagem, baixa também.
    await client.query('UPDATE wm_products SET stock = GREATEST(0, stock - $1) WHERE id = $2', [qty, p.id]);
    await client.query('COMMIT');
    res.json({ success: true, sale });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[wmstore] sale:', e.message);
    res.status(500).json({ success: false, error: 'Erro ao registrar venda' });
  } finally {
    client.release();
  }
});

router.get('/wm/admin/sales', requireAdmin, async (req, res) => {
  try {
    await ensureTables();
    const r = await pool.query('SELECT * FROM wm_sales ORDER BY created_at DESC LIMIT 300');
    res.json({ success: true, sales: r.rows });
  } catch (e) {
    console.error('[wmstore] sales:', e.message);
    res.status(500).json({ success: false, error: 'Erro ao carregar vendas' });
  }
});

// Desfazer venda (registro errado): apaga e devolve a quantidade ao estoque.
router.delete('/wm/admin/sales/:id', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTables();
    await client.query('BEGIN');
    const s = (await client.query('DELETE FROM wm_sales WHERE id = $1 RETURNING *', [num(req.params.id)])).rows[0];
    if (s && s.product_id) {
      await client.query('UPDATE wm_products SET stock = stock + $1 WHERE id = $2', [s.qty, s.product_id]);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[wmstore] undo sale:', e.message);
    res.status(500).json({ success: false, error: 'Erro ao desfazer venda' });
  } finally {
    client.release();
  }
});

// ---- Admin: resumo do dashboard ------------------------------------------
router.get('/wm/admin/summary', requireAdmin, async (req, res) => {
  try {
    await ensureTables();
    const [prod, month, total] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'ativo')                             AS active,
          COALESCE(SUM(stock) FILTER (WHERE origin = 'proprio'), 0)            AS own_units,
          COALESCE(SUM(stock * cost) FILTER (WHERE origin = 'proprio'), 0)     AS own_cost_value,
          COALESCE(SUM(stock * price) FILTER (WHERE origin = 'proprio'), 0)    AS own_sale_value,
          COUNT(*) FILTER (WHERE origin = 'fornecedor' AND status = 'ativo')   AS supplier_items
        FROM wm_products
      `),
      pool.query(`
        SELECT COALESCE(SUM(qty * unit_price), 0) AS revenue,
               COALESCE(SUM(qty * (unit_price - unit_cost)), 0) AS profit,
               COALESCE(SUM(qty), 0) AS units
        FROM wm_sales WHERE date_trunc('month', sold_at) = date_trunc('month', NOW())
      `),
      pool.query(`
        SELECT COALESCE(SUM(qty * unit_price), 0) AS revenue,
               COALESCE(SUM(qty * (unit_price - unit_cost)), 0) AS profit,
               COALESCE(SUM(qty), 0) AS units
        FROM wm_sales
      `),
    ]);
    res.json({ success: true, products: prod.rows[0], month: month.rows[0], total: total.rows[0] });
  } catch (e) {
    console.error('[wmstore] summary:', e.message);
    res.status(500).json({ success: false, error: 'Erro ao carregar resumo' });
  }
});

module.exports = router;
