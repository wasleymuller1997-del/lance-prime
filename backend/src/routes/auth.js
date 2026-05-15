const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/users.json');

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
      created_at: new Date().toISOString()
    };

    users.push(user);
    saveUsers(users);

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ success: false, error: 'Token não fornecido' });

  try {
    const token = auth.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const users = getUsers();
    const user = users.find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, phone: user.phone } });
  } catch (err) {
    res.status(401).json({ success: false, error: 'Token inválido' });
  }
});

module.exports = router;
