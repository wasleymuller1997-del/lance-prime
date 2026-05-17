const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/users.json');

// Admin credentials
const ADMIN_USER = 'admin';
const ADMIN_PASS = '986731';

function ensureDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '[]');
}

function getUsers() {
  ensureDB();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function saveUsers(users) {
  ensureDB();
  fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}

// Middleware to verify admin token
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ success: false, error: 'Token não fornecido' });
  try {
    const token = auth.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Acesso negado' });
    }
    req.admin = decoded;
    next();
  } catch (err) {
    res.status(401).json({ success: false, error: 'Token inválido' });
  }
}

// Middleware to verify user is authenticated and approved
function requireApproved(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ success: false, error: 'Faça login para continuar' });
  try {
    const token = auth.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Admin can do anything
    if (decoded.role === 'admin') {
      req.user = decoded;
      return next();
    }
    const users = getUsers();
    const user = users.find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    if (!user.approved) {
      return res.status(403).json({ success: false, error: 'Sua conta está em análise. Aguarde aprovação do administrador.' });
    }
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ success: false, error: 'Token inválido' });
  }
}

// Admin login
router.post('/admin-login', (req, res) => {
  const { user, password } = req.body;
  if (user === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ role: 'admin', user: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.json({ success: true, token, user: { name: 'Administrador', role: 'admin' } });
  }
  res.status(401).json({ success: false, error: 'Credenciais inválidas' });
});

// User register
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, cpf, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: 'Nome, email e senha são obrigatórios' });
    }

    const users = getUsers();
    if (users.find(u => u.email === email)) {
      return res.status(400).json({ success: false, error: 'Email já cadastrado' });
    }

    const hash = await bcrypt.hash(password, 10);
    const user = {
      id: Date.now(),
      name,
      email,
      phone: phone || '',
      cpf: cpf || '',
      password: hash,
      approved: false,
      created_at: new Date().toISOString()
    };

    users.push(user);
    saveUsers(users);

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, approved: false } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// User login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email e senha obrigatórios' });
    }

    const users = getUsers();
    const user = users.find(u => u.email === email);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Email ou senha incorretos' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Email ou senha incorretos' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, approved: user.approved || false } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get current user
router.get('/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ success: false, error: 'Token não fornecido' });

  try {
    const token = auth.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role === 'admin') {
      return res.json({ success: true, user: { name: 'Administrador', role: 'admin', approved: true } });
    }
    const users = getUsers();
    const user = users.find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, phone: user.phone, approved: user.approved || false } });
  } catch (err) {
    res.status(401).json({ success: false, error: 'Token inválido' });
  }
});

// === ADMIN ROUTES ===

// List all users
router.get('/admin/users', requireAdmin, (req, res) => {
  const users = getUsers();
  const safe = users.map(u => ({
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone || '',
    cpf: u.cpf || '',
    approved: u.approved || false,
    created_at: u.created_at
  }));
  res.json({ success: true, data: safe });
});

// Approve user
router.post('/admin/users/:id/approve', requireAdmin, (req, res) => {
  const users = getUsers();
  const user = users.find(u => u.id === parseInt(req.params.id));
  if (!user) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
  user.approved = true;
  saveUsers(users);
  res.json({ success: true, message: 'Usuário aprovado' });
});

// Reject user
router.post('/admin/users/:id/reject', requireAdmin, (req, res) => {
  const users = getUsers();
  const user = users.find(u => u.id === parseInt(req.params.id));
  if (!user) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
  user.approved = false;
  saveUsers(users);
  res.json({ success: true, message: 'Usuário rejeitado' });
});

// Delete user
router.delete('/admin/users/:id', requireAdmin, (req, res) => {
  let users = getUsers();
  const idx = users.findIndex(u => u.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
  users.splice(idx, 1);
  saveUsers(users);
  res.json({ success: true, message: 'Usuário removido' });
});

module.exports = router;
module.exports.requireApproved = requireApproved;
