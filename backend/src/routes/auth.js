const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../services/db');

const ADMIN_USER = 'admin';
const ADMIN_PASS = '986731';

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ success: false, error: 'Token não fornecido' });
  try {
    const token = auth.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ success: false, error: 'Acesso negado' });
    req.admin = decoded;
    next();
  } catch (err) {
    res.status(401).json({ success: false, error: 'Token inválido' });
  }
}

function requireApproved(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ success: false, error: 'Faça login para continuar' });
  try {
    const token = auth.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role === 'admin') { req.user = decoded; return next(); }
    pool.query('SELECT * FROM users WHERE id = $1', [decoded.id]).then(result => {
      const user = result.rows[0];
      if (!user) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
      if (!user.approved) return res.status(403).json({ success: false, error: 'Sua conta está em análise. Aguarde aprovação do administrador.' });
      req.user = user;
      next();
    }).catch(() => res.status(500).json({ success: false, error: 'Erro interno' }));
  } catch (err) {
    res.status(401).json({ success: false, error: 'Token inválido' });
  }
}

router.post('/admin-login', (req, res) => {
  const { user, password } = req.body;
  if (user === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ role: 'admin', user: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.json({ success: true, token, user: { name: 'Administrador', role: 'admin' } });
  }
  res.status(401).json({ success: false, error: 'Credenciais inválidas' });
});

router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, cpf, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ success: false, error: 'Nome, email e senha são obrigatórios' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(400).json({ success: false, error: 'Email já cadastrado' });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, phone, cpf, password) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, approved',
      [name, email, phone || '', cpf || '', hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, approved: user.approved } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email e senha obrigatórios' });

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ success: false, error: 'Email ou senha incorretos' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ success: false, error: 'Email ou senha incorretos' });

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, approved: user.approved } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/me', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ success: false, error: 'Token não fornecido' });
  try {
    const token = auth.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role === 'admin') return res.json({ success: true, user: { name: 'Administrador', role: 'admin', approved: true } });
    const result = await pool.query('SELECT id, name, email, phone, approved FROM users WHERE id = $1', [decoded.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(401).json({ success: false, error: 'Token inválido' });
  }
});

router.get('/admin/users', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT id, name, email, phone, cpf, approved, created_at FROM users ORDER BY created_at DESC');
  res.json({ success: true, data: result.rows });
});

router.post('/admin/users/:id/approve', requireAdmin, async (req, res) => {
  const result = await pool.query('UPDATE users SET approved = true WHERE id = $1 RETURNING id', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
  res.json({ success: true, message: 'Usuário aprovado' });
});

router.post('/admin/users/:id/reject', requireAdmin, async (req, res) => {
  const result = await pool.query('UPDATE users SET approved = false WHERE id = $1 RETURNING id', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
  res.json({ success: true, message: 'Usuário rejeitado' });
});

router.delete('/admin/users/:id', requireAdmin, async (req, res) => {
  const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
  res.json({ success: true, message: 'Usuário removido' });
});

module.exports = router;
module.exports.requireApproved = requireApproved;
