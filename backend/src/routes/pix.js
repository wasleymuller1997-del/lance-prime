const express = require('express');
const router = express.Router();
const { criarCobrancaPix, consultarCobranca } = require('../services/nuvende');
const { pool } = require('../services/db');
const jwt = require('jsonwebtoken');

function getUserFromToken(req) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return null;
    return jwt.verify(token, process.env.JWT_SECRET || 'lance-prime-secret-2024');
  } catch { return null; }
}

// Gerar PIX (sinal 10% ou pagamento total)
router.post('/pix/gerar', async (req, res) => {
  try {
    const user = getUserFromToken(req);
    if (!user) return res.status(401).json({ success: false, error: 'Login necessário' });

    const { valor, tipo, advertisementId, vehicleInfo, descricao } = req.body;
    if (!valor || valor <= 0) return res.status(400).json({ success: false, error: 'Valor inválido' });

    const desc = descricao || (tipo === 'sinal' ? 'Sinal 10% - ' + (vehicleInfo || '') : 'Pagamento - ' + (vehicleInfo || ''));

    const cobranca = await criarCobrancaPix({
      valor,
      descricao: desc,
      devedor: { nome: user.name || 'Cliente', cpf: user.cpf || '' },
      expiracaoSegundos: 3600
    });

    // Salvar no banco
    await pool.query(
      `INSERT INTO pix_cobrancas (user_id, user_name, user_email, txid, valor, descricao, tipo, status, pix_copia_cola, advertisement_id, vehicle_info)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [user.id, user.name, user.email, cobranca.txid, valor, desc, tipo || 'sinal', 'ATIVA', cobranca.pixCopiaCola, advertisementId || null, vehicleInfo || '']
    );

    res.json({ success: true, data: cobranca });
  } catch (err) {
    console.error('Erro ao gerar PIX:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Consultar status do PIX
router.get('/pix/status/:txid', async (req, res) => {
  try {
    const result = await consultarCobranca(req.params.txid);
    const isPaid = result.status === 'CONCLUIDA' || result.status === 'EFETIVADO';

    if (isPaid) {
      await pool.query(
        `UPDATE pix_cobrancas SET status = 'CONCLUIDA', paid_at = NOW() WHERE txid = $1 AND status != 'CONCLUIDA'`,
        [req.params.txid]
      );
    }

    res.json({ success: true, data: { txid: req.params.txid, status: result.status, paid: isPaid } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Webhook Nuvende (confirmação de pagamento)
router.post('/webhooks/nuvende', async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook Nuvende recebido:', JSON.stringify(body).substring(0, 500));

    const pixArray = body.pix || [];
    for (const pix of pixArray) {
      const txid = pix.txid;
      if (!txid) continue;

      await pool.query(
        `UPDATE pix_cobrancas SET status = 'CONCLUIDA', paid_at = NOW() WHERE txid = $1`,
        [txid]
      );
      console.log(`PIX confirmado: txid=${txid}, valor=${pix.valor}`);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro webhook:', err.message);
    res.status(200).json({ ok: true });
  }
});

// Admin: listar cobranças PIX
router.get('/admin/pix', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pix_cobrancas ORDER BY created_at DESC LIMIT 100');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Minhas cobranças (cliente)
router.get('/my-pix', async (req, res) => {
  try {
    const user = getUserFromToken(req);
    if (!user) return res.json({ success: true, data: [] });
    const result = await pool.query('SELECT * FROM pix_cobrancas WHERE user_id = $1 ORDER BY created_at DESC', [user.id]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

module.exports = router;
