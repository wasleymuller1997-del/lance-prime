const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../services/db');

// Credenciais admin via variáveis de ambiente (NUNCA hardcoded)
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS;

// Versao atual dos Termos de Uso. INCREMENTAR quando o texto mudar
// MATERIALMENTE (multa, prazo, regras de cancelamento). Cliente com
// terms_version != CURRENT precisa re-aceitar.
const CURRENT_TERMS_VERSION = '2026.2';
module.exports.CURRENT_TERMS_VERSION = CURRENT_TERMS_VERSION;

// Validação crítica: servidor não deve iniciar sem senha admin configurada
if (!ADMIN_PASS) {
  console.error('ERRO CRÍTICO: ADMIN_PASS não configurada nas variáveis de ambiente!');
  console.error('Configure ADMIN_PASS no arquivo .env antes de iniciar o servidor.');
}

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

// Middleware mais estrito que requireApproved: usado nos endpoints de LANCE.
// Alem de aprovado, exige: (1) ter aceito a versao atual dos termos;
// (2) ter pelo menos 1 documento subido. Retorna erros estruturados (code)
// pro frontend abrir a tela certa: TERMS_OUTDATED -> modal de re-aceite,
// NO_DOCUMENTS -> manda pra Minha Conta.
function requireBidEligible(req, res, next) {
  requireApproved(req, res, async (err) => {
    if (err) return next(err);
    if (!req.user || req.user.role === 'admin') return next();
    try {
      // Aceite dos termos atualizado
      if (!req.user.terms_accepted_at || req.user.terms_version !== CURRENT_TERMS_VERSION) {
        return res.status(403).json({
          success: false,
          code: 'TERMS_OUTDATED',
          current_version: CURRENT_TERMS_VERSION,
          error: 'Você precisa aceitar a versão atual dos Termos de Uso antes de dar lance.'
        });
      }
      // Documento verificado pelo admin. Subir nao basta — o dono precisa
      // analisar e marcar verified=TRUE. Se subiu mas ainda nao foi aprovado,
      // retorna codigo DOCS_PENDING (mensagem amigavel pro cliente esperar).
      const docsAll = await pool.query('SELECT verified FROM user_documents WHERE user_id = $1', [req.user.id]);
      if (docsAll.rows.length === 0) {
        return res.status(403).json({
          success: false,
          code: 'NO_DOCUMENTS',
          error: 'Envie seus documentos (CNH, RG e comprovante de endereço) em Minha Conta antes de dar lance.'
        });
      }
      const verifiedCount = docsAll.rows.filter(r => r.verified === true).length;
      if (verifiedCount === 0) {
        return res.status(403).json({
          success: false,
          code: 'DOCS_PENDING',
          error: 'Seus documentos foram recebidos e estão em análise. Você poderá dar lance assim que pelo menos um for aprovado pelo administrador.'
        });
      }
      next();
    } catch (e) {
      res.status(500).json({ success: false, error: 'Erro interno' });
    }
  });
}

router.post('/admin-login', (req, res) => {
  const { user, password } = req.body;
  if (!ADMIN_PASS) {
    return res.status(500).json({ success: false, error: 'Servidor não configurado corretamente' });
  }
  if (user === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ role: 'admin', user: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.json({ success: true, token, user: { name: 'Administrador', role: 'admin' } });
  }
  res.status(401).json({ success: false, error: 'Credenciais inválidas' });
});

// Middleware: qualquer cliente logado (aprovado ou não) — pra mexer no proprio perfil.
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ success: false, error: 'Faça login para continuar' });
  try {
    const decoded = jwt.verify(auth.replace('Bearer ', ''), process.env.JWT_SECRET);
    if (decoded.role === 'admin') return res.status(403).json({ success: false, error: 'Use uma conta de cliente' });
    req.userId = decoded.id;
    next();
  } catch (err) {
    res.status(401).json({ success: false, error: 'Token inválido' });
  }
}

// Colunas de perfil editaveis pelo proprio cliente.
const PROFILE_FIELDS = ['name', 'phone', 'cpf', 'birth_date', 'person_type', 'cnpj', 'company_name', 'cep', 'street', 'number', 'complement', 'neighborhood', 'city', 'uf'];

router.post('/register', async (req, res) => {
  try {
    const b = req.body;
    const { name, email, password } = b;
    if (!name || !email || !password) return res.status(400).json({ success: false, error: 'Nome, email e senha são obrigatórios' });
    // Aceite dos termos e' OBRIGATORIO (frontend ja valida via required no
    // checkbox, aqui e a 2a camada — defesa em profundidade).
    if (!b.terms_accepted) return res.status(400).json({ success: false, error: 'Você precisa aceitar os Termos de Uso pra criar a conta.' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(400).json({ success: false, error: 'Email já cadastrado' });

    // Audit trail do aceite: timestamp + versao dos termos + IP de origem.
    // Versao vem do frontend (lemos da data-attr no checkbox) — incrementa quando
    // o texto dos termos muda materialmente.
    const termsVersion = b.terms_version || '2026.1';
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim().slice(0, 45);

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password, phone, cpf, birth_date, person_type, cnpj, company_name, cep, street, number, complement, neighborhood, city, uf, terms_accepted_at, terms_version, terms_accepted_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, NOW(), $17, $18) RETURNING id, name, email, approved`,
      [name, email, hash, b.phone || '', b.cpf || '', b.birth_date || null, b.person_type || 'fisica', b.cnpj || '', b.company_name || '',
       b.cep || '', b.street || '', b.number || '', b.complement || '', b.neighborhood || '', b.city || '', b.uf || '',
       termsVersion, clientIp]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
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

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
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
    const result = await pool.query(
      `SELECT id, name, email, phone, cpf, approved, created_at, birth_date, person_type, cnpj, company_name, cep, street, number, complement, neighborhood, city, uf, terms_accepted_at, terms_version FROM users WHERE id = $1`,
      [decoded.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(401).json({ success: false, error: 'Token inválido' });
  }
});

// Diz se o cliente esta com a versao atual dos termos aceita.
// Frontend chama no boot — se up_to_date=false, abre modal de re-aceite.
router.get('/me/terms-status', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.json({ success: true, up_to_date: false, current_version: CURRENT_TERMS_VERSION });
  try {
    const token = auth.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role === 'admin') return res.json({ success: true, up_to_date: true, current_version: CURRENT_TERMS_VERSION });
    const r = await pool.query('SELECT terms_accepted_at, terms_version FROM users WHERE id = $1', [decoded.id]);
    if (!r.rows.length) return res.json({ success: true, up_to_date: false, current_version: CURRENT_TERMS_VERSION });
    const u = r.rows[0];
    res.json({
      success: true,
      up_to_date: !!u.terms_accepted_at && u.terms_version === CURRENT_TERMS_VERSION,
      current_version: CURRENT_TERMS_VERSION,
      user_version: u.terms_version || null,
      user_accepted_at: u.terms_accepted_at || null
    });
  } catch (err) {
    res.json({ success: true, up_to_date: false, current_version: CURRENT_TERMS_VERSION });
  }
});

// Usuario re-aceita a versao atual. Salva timestamp + IP no banco como prova.
router.post('/me/accept-terms', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ success: false, error: 'Faça login' });
  try {
    const token = auth.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role === 'admin') return res.json({ success: true });
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim().slice(0, 45);
    await pool.query(
      'UPDATE users SET terms_accepted_at = NOW(), terms_version = $1, terms_accepted_ip = $2 WHERE id = $3',
      [CURRENT_TERMS_VERSION, clientIp, decoded.id]
    );
    res.json({ success: true, current_version: CURRENT_TERMS_VERSION });
  } catch (err) {
    res.status(401).json({ success: false, error: 'Token inválido' });
  }
});

// Atualiza o proprio perfil
router.patch('/me', requireAuth, async (req, res) => {
  try {
    const sets = [], vals = [];
    let i = 1;
    for (const k of PROFILE_FIELDS) {
      if (k in req.body) {
        sets.push(`${k} = $${i++}`);
        vals.push(k === 'birth_date' ? (req.body[k] || null) : (req.body[k] || ''));
      }
    }
    if (!sets.length) return res.json({ success: true });
    vals.push(req.userId);
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i}`, vals);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Troca de senha
router.post('/me/password', requireAuth, async (req, res) => {
  try {
    const current = req.body.current;
    const newPassword = req.body.newPassword;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ success: false, error: 'Nova senha deve ter no mínimo 6 caracteres' });
    const r = await pool.query('SELECT password FROM users WHERE id = $1', [req.userId]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    const ok = await bcrypt.compare(current || '', r.rows[0].password);
    if (!ok) return res.status(400).json({ success: false, error: 'Senha atual incorreta' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, req.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Documentos do cliente (BYTEA no banco) ===
const MAX_DOC_BYTES = 5 * 1024 * 1024;

router.post('/me/documents', requireAuth, async (req, res) => {
  try {
    const { doc_type, filename, mime, data } = req.body;
    if (!data) return res.status(400).json({ success: false, error: 'Arquivo obrigatório' });
    const buf = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buf.length > MAX_DOC_BYTES) return res.status(400).json({ success: false, error: 'Arquivo muito grande (máx 5MB)' });
    const r = await pool.query(
      'INSERT INTO user_documents (user_id, doc_type, filename, mime, data) VALUES ($1,$2,$3,$4,$5) RETURNING id, doc_type, filename, mime, created_at',
      [req.userId, doc_type || 'documento', filename || 'arquivo', mime || 'application/octet-stream', buf]
    );
    res.json({ success: true, document: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/me/documents', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT id, doc_type, filename, mime, verified, verified_at, rejected_reason, created_at FROM user_documents WHERE user_id = $1 ORDER BY created_at DESC', [req.userId]);
  res.json({ success: true, data: r.rows });
});

router.get('/me/documents/:id', requireAuth, async (req, res) => {
  const r = await pool.query('SELECT mime, data FROM user_documents WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  if (!r.rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
  res.setHeader('Content-Type', r.rows[0].mime || 'application/octet-stream');
  res.send(r.rows[0].data);
});

router.delete('/me/documents/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM user_documents WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.json({ success: true });
});

router.get('/admin/users', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT id, name, email, phone, cpf, person_type, city, uf, approved, blocked, created_at FROM users ORDER BY created_at DESC');
  res.json({ success: true, data: result.rows });
});

// Perfil completo do cliente (admin) + lista de documentos
router.get('/admin/users/:id', requireAdmin, async (req, res) => {
  const u = await pool.query(
    `SELECT id, name, email, phone, cpf, approved, created_at, birth_date, person_type, cnpj, company_name, cep, street, number, complement, neighborhood, city, uf FROM users WHERE id = $1`,
    [req.params.id]
  );
  if (!u.rows.length) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
  const docs = await pool.query('SELECT id, doc_type, filename, mime, verified, verified_at, verified_by, rejected_reason, created_at FROM user_documents WHERE user_id = $1 ORDER BY created_at DESC', [req.params.id]);
  res.json({ success: true, user: u.rows[0], documents: docs.rows });
});

// Serve um documento do cliente (admin)
router.get('/admin/users/:id/documents/:docId', requireAdmin, async (req, res) => {
  const r = await pool.query('SELECT mime, data FROM user_documents WHERE id = $1 AND user_id = $2', [req.params.docId, req.params.id]);
  if (!r.rows.length) return res.status(404).json({ success: false, error: 'Não encontrado' });
  res.setHeader('Content-Type', r.rows[0].mime || 'application/octet-stream');
  res.send(r.rows[0].data);
});

// Admin aprova um documento (verified=TRUE). Cliente passa a poder dar lance
// se tinha esse como unico doc.
router.post('/admin/users/:id/documents/:docId/verify', requireAdmin, async (req, res) => {
  const adminUser = (req.admin && req.admin.user) || 'admin';
  const r = await pool.query(
    `UPDATE user_documents
     SET verified = TRUE, verified_at = NOW(), verified_by = $1, rejected_reason = NULL
     WHERE id = $2 AND user_id = $3 RETURNING id`,
    [adminUser, req.params.docId, req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ success: false, error: 'Documento não encontrado' });
  res.json({ success: true });
});

// Admin rejeita o documento (verified=FALSE + motivo). O cliente ve o motivo
// pra subir outro corrigido.
router.post('/admin/users/:id/documents/:docId/reject', requireAdmin, async (req, res) => {
  const reason = (req.body && req.body.reason) ? String(req.body.reason).slice(0, 500) : null;
  const r = await pool.query(
    `UPDATE user_documents
     SET verified = FALSE, verified_at = NOW(), rejected_reason = $1
     WHERE id = $2 AND user_id = $3 RETURNING id`,
    [reason, req.params.docId, req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ success: false, error: 'Documento não encontrado' });
  res.json({ success: true });
});

router.post('/admin/users/:id/approve', requireAdmin, async (req, res) => {
  // Aprovar tambem DESBLOQUEIA (blocked=false): serve pra reativar um cliente
  // que estava bloqueado sem precisar de outro botao.
  const result = await pool.query('UPDATE users SET approved = true, blocked = false WHERE id = $1 RETURNING id', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
  res.json({ success: true, message: 'Usuário aprovado' });
});

router.post('/admin/users/:id/reject', requireAdmin, async (req, res) => {
  // Bloquear: approved=false + blocked=true. O blocked=true e o que separa um
  // cliente bloqueado de um cadastro que ainda nem foi analisado.
  const result = await pool.query('UPDATE users SET approved = false, blocked = true WHERE id = $1 RETURNING id', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
  res.json({ success: true, message: 'Usuário bloqueado' });
});

router.delete('/admin/users/:id', requireAdmin, async (req, res) => {
  const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
  res.json({ success: true, message: 'Usuário removido' });
});

module.exports = router;
module.exports.requireApproved = requireApproved;
module.exports.requireBidEligible = requireBidEligible;
module.exports.requireAdmin = requireAdmin;
module.exports.CURRENT_TERMS_VERSION = CURRENT_TERMS_VERSION;
