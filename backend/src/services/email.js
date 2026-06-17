/**
 * Envio de emails transacionais via Resend (https://resend.com).
 *
 * Sem SDK: usa fetch direto contra a API REST. Vantagem: zero peso de
 * dependencia, funciona em qualquer Node moderno (>=18 tem fetch nativo).
 *
 * Config:
 *   RESEND_API_KEY  — token criado em resend.com/api-keys
 *   EMAIL_FROM      — "LancePrime <noreply@SEU_DOMINIO>" (precisa ter dominio
 *                     verificado na Resend; sem verificar, da pra usar o
 *                     onboarding@resend.dev pra teste)
 *
 * Se faltar config, NAO derruba o servidor — log de warn e funcoes viram noop.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'LancePrime <onboarding@resend.dev>';
const SITE_URL = process.env.SITE_URL || 'https://lanceprimecars.com';

function isEnabled() { return !!RESEND_API_KEY; }

async function sendEmail({ to, subject, html, text }) {
  if (!isEnabled()) {
    console.warn('[email] RESEND_API_KEY nao configurada — pulando envio pra', to);
    return { skipped: true };
  }
  if (!to || !subject) throw new Error('email: to e subject sao obrigatorios');
  const body = {
    from: EMAIL_FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    html: html || undefined,
    text: text || undefined,
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[email] Resend retornou erro', res.status, data);
    throw new Error('email: HTTP ' + res.status + ' — ' + (data.message || JSON.stringify(data)));
  }
  return { id: data.id, ok: true };
}

/**
 * Email pro cliente que acabou de vencer um leilao. Mostra valor do sinal,
 * deadline (5 min), dados de pagamento e link pro painel.
 *
 * @param {object} bid — linha do banco (vehicle_brand, vehicle_model, final_price, payment_deadline)
 * @param {object} user — linha do banco (name, email)
 * @param {object} payment — settings.platform_settings (CNPJ, PIX, banco...)
 */
async function sendWinnerEmail(bid, user, payment) {
  if (!user || !user.email) return { skipped: true, reason: 'sem email' };
  const vehicle = ((bid.vehicle_brand || '') + ' ' + (bid.vehicle_model || '')).trim() || 'Veículo';
  // Valor que o cliente VIU e ofertou (com margem 5% ja incluida). Sinal de
  // 10% e cobrado em cima disso, nao do final_price cru da Dealers.
  const final = parseFloat(bid.bid_value || bid.final_price) || 0;
  const sinal = (final * 0.10).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const deadline = bid.payment_deadline
    ? new Date(bid.payment_deadline).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    : 'em 5 minutos';
  const p = payment || {};
  const pixLine = p.pay_pix_key
    ? `<p><strong>Chave PIX (${p.pay_pix_tipo || ''}):</strong> <code style="background:#eee;padding:2px 6px;border-radius:4px">${escHtml(p.pay_pix_key)}</code></p>`
    : '';
  const bankLine = (p.pay_banco || p.pay_agencia || p.pay_conta)
    ? `<p><strong>Banco:</strong> ${escHtml(p.pay_banco||'')}<br><strong>Agência:</strong> ${escHtml(p.pay_agencia||'')}<br><strong>Conta:</strong> ${escHtml(p.pay_conta||'')}</p>`
    : '';
  const cnpjLine = p.pay_cnpj
    ? `<p><strong>${p.pay_razao_social ? escHtml(p.pay_razao_social)+'<br>' : ''}CNPJ/CPF:</strong> ${escHtml(p.pay_cnpj)}</p>`
    : '';

  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;line-height:1.6;color:#222;max-width:560px;margin:0 auto;padding:20px">
    <div style="background:linear-gradient(135deg,#c9a96e,#8b6f3a);color:#fff;padding:24px;border-radius:10px 10px 0 0;text-align:center">
      <h1 style="margin:0;font-size:22px">🏆 Você venceu o leilão!</h1>
    </div>
    <div style="border:1px solid #ddd;border-top:none;padding:24px;border-radius:0 0 10px 10px">
      <p>Olá ${escHtml(user.name || '')},</p>
      <p>Sua oferta de <strong>${final.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</strong> no <strong>${escHtml(vehicle)}</strong> foi a vencedora!</p>

      <div style="background:#fff5d6;border-left:4px solid #c9a96e;padding:14px 18px;margin:18px 0;border-radius:4px">
        <p style="margin:0 0 6px"><strong>Sinal de 10% a pagar agora:</strong></p>
        <p style="margin:0;font-size:28px;font-weight:bold;color:#8b6f3a">${sinal}</p>
        <p style="margin:8px 0 0;color:#a00;font-size:14px"><strong>Prazo: ${escHtml(deadline)}</strong> (5 minutos a partir do encerramento do leilão).</p>
      </div>

      <h3 style="color:#444">Como pagar:</h3>
      ${pixLine}
      ${cnpjLine}
      ${bankLine}
      ${p.pay_observacoes ? `<p style="background:#eef;padding:10px;border-radius:6px;font-size:14px"><strong>Observação:</strong> ${escHtml(p.pay_observacoes)}</p>` : ''}

      <p style="background:#ffe5e5;padding:10px;border-radius:6px;font-size:14px;color:#a00"><strong>⚠️ Importante:</strong> sem o pagamento dentro do prazo, a oferta é cancelada e a multa de 10% sobre o valor da oferta + multa adicional se aplicam, conforme o item 4 dos Termos de Uso.</p>

      <p style="text-align:center;margin:28px 0 10px"><a href="${SITE_URL}/#dashboard" style="background:#c9a96e;color:#1a1206;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block">Abrir Meu Painel</a></p>

      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="font-size:12px;color:#888;text-align:center">LancePrime — Plataforma de venda direta de veículos<br>Você está recebendo isto porque venceu um leilão na nossa plataforma.</p>
    </div>
  </body></html>`;

  const text = `Voce venceu o leilao!\n\nVeiculo: ${vehicle}\nValor da oferta: ${final.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}\nSinal de 10% a pagar agora: ${sinal}\nPrazo: ${deadline}\n\nDados PIX:\n${p.pay_razao_social || ''}\nCNPJ/CPF: ${p.pay_cnpj || ''}\nChave PIX (${p.pay_pix_tipo||''}): ${p.pay_pix_key || ''}\n\nAbra o painel: ${SITE_URL}/#dashboard\n\nAtencao: sem pagamento no prazo, a multa do item 4 dos termos se aplica.`;

  return sendEmail({
    to: user.email,
    subject: '🏆 Você venceu! Pague o sinal em 5 minutos — LancePrime',
    html,
    text,
  });
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { sendEmail, sendWinnerEmail, isEnabled };
