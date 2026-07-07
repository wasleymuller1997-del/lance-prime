/**
 * Reconciliação de lances: fonte da verdade dos resultados.
 *
 * Premissa: durante o leilão, o sistema só sabe "quem ta levando agora" via
 * polling/Pusher (efêmero). Depois que o leilão fecha, esse dado some — a
 * Dealers tira o anuncio do feed em ~3h. Se a gente não capturar o resultado
 * NO MOMENTO do fechamento, perdemos a info pra sempre.
 *
 * Esse modulo roda em ciclos (cron interno via setInterval no server.js):
 *  1. Busca todos os lances com outcome=NULL cujo auction_end_date ja passou
 *     (com 2min de grace pro lance-relampago acontecer).
 *  2. Pra cada advertisement_id unico, bate em dealers.getOffers() pra ver
 *     qual foi a oferta vencedora final.
 *  3. Cruza com os lances locais: se o valor da oferta vencedora == o lance
 *     do nosso usuario, ele venceu. Senao, perdeu.
 *  4. Persiste outcome, final_price, won_at no banco. Se "venceu", cria linha
 *     em purchases (status=disponivel ate o admin aprovar).
 *
 * Robustez:
 *  - Se a Dealers cair em alguma chamada, marca reconciled_at MAS NAO seta
 *    outcome — proxima execucao reprocessa.
 *  - Idempotente: rodar 10x seguidas nao cria duplicata em purchases (o link
 *    bid_id na coluna purchases.bid_id evita).
 *  - Multi-conta: por enquanto so usa a conta padrao (dealers singleton).
 */

const dealers = require('./dealers');
const { pool } = require('./db');
const email = require('./email');

const GRACE_AFTER_END_MS = 45 * 1000; // 45s: rapido pos-fechamento (o vigia ja capturou o lider). Antes 2min.
const SPREAD_PCT = parseFloat(process.env.SPREAD_PCT || '0.05'); // 5% spread

let running = false;
let lastRunAt = null;
let lastSummary = null;

// Remove o spread pra comparar com o valor real que aparece na Dealers.
// Cliente ve "R$ 50.000" no LancePrime; Dealers grava "R$ 47.619" (50000/1.05).
function removeSpread(value) {
  const v = parseFloat(value) || 0;
  return v / (1 + SPREAD_PCT);
}

async function reconcileOnce() {
  if (running) {
    return { skipped: true, reason: 'ja-rodando' };
  }
  running = true;
  const summary = {
    started_at: new Date().toISOString(),
    pending_before: 0,
    advertisements_checked: 0,
    bids_marked_won: 0,
    bids_marked_lost: 0,
    bids_still_pending: 0,
    errors: [],
    purchases_created: 0,
  };
  try {
    // 1. Lances pendentes cujo leilao ja deveria ter fechado.
    // Pega tambem lances ANTIGOS sem auction_end_date (legado de antes da
    // coluna existir) que tem mais de 3h de vida — sem isso ficavam presos
    // como "Em andamento" pra sempre, deixando o admin tonto.
    const cutoff = new Date(Date.now() - GRACE_AFTER_END_MS);
    const oldCutoff = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h
    const pendingRes = await pool.query(
      `SELECT id, user_id, advertisement_id, bid_value, bid_type, auction_end_date, vehicle_snapshot, last_leading_value
       FROM bids
       WHERE (outcome IS NULL OR outcome = 'indeterminado')
         AND (
           (auction_end_date IS NOT NULL AND auction_end_date <= $1)
           OR (auction_end_date IS NULL AND created_at <= $2)
         )
       ORDER BY COALESCE(auction_end_date, created_at) ASC`,
      [cutoff, oldCutoff]
    );
    summary.pending_before = pendingRes.rows.length;
    if (pendingRes.rows.length === 0) {
      summary.note = 'nenhum lance pendente vencido';
      lastSummary = summary;
      return summary;
    }

    // 2. Agrupa por advertisement_id (evita chamar Dealers N vezes pro mesmo lote)
    const byAd = new Map();
    for (const b of pendingRes.rows) {
      if (!byAd.has(b.advertisement_id)) byAd.set(b.advertisement_id, []);
      byAd.get(b.advertisement_id).push(b);
    }

    // 3. Pra cada advertisement, descobre o resultado final via Dealers
    for (const [adId, bids] of byAd.entries()) {
      try {
        summary.advertisements_checked++;
        const offers = await dealers.getOffers(adId);
        // Resposta da Dealers: array de ofertas ordenadas. A 1a (maior) e a vencedora.
        // Estrutura tipica: [{ value, user_id, shop_id, created_at, ... }, ...]
        let winningValue = null;
        if (Array.isArray(offers) && offers.length > 0) {
          // Pega o MAIOR value (mesmo se vier desordenado)
          winningValue = offers.reduce((mx, o) => {
            const v = parseFloat(o.value) || 0;
            return v > mx ? v : mx;
          }, 0);
        } else if (offers && offers.offers && Array.isArray(offers.offers)) {
          winningValue = offers.offers.reduce((mx, o) => {
            const v = parseFloat(o.value) || 0;
            return v > mx ? v : mx;
          }, 0);
        } else if (offers && typeof offers.winning_value !== 'undefined') {
          winningValue = parseFloat(offers.winning_value) || 0;
        }

        if (winningValue == null || winningValue <= 0) {
          // Dealers nao retornou ofertas. Pra bids RECENTES (vencimento ha
          // menos de 24h), pode ser intermitencia — deixa pendente, tenta de
          // novo. Pra bids ANTIGOS (>24h), o lote saiu do feed da Dealers.
          //
          // A Dealers nao devolveu ofertas (lote saiu do feed no fechamento).
          // AGORA usamos o "vigia de fechamento": last_leading_value guarda o
          // maior lance visto ENQUANTO o leilao estava no ar. Se temos esse
          // valor, ja da pra decidir vencedor/perdedor SEM depender da Dealers —
          // e dispara o 10% na hora. So ficamos 'indeterminado' se nunca
          // capturamos nada (ai o admin confere e corrige). NUNCA 'perdeu' no
          // escuro (foi o bug que enganou o Douglas).
          for (const b of bids) {
            const lead = parseFloat(b.last_leading_value);
            if (lead && lead > 0) {
              const r = await finalizeBidFromValue(b, lead);
              if (r === 'venceu') summary.bids_marked_won++;
              else if (r === 'perdeu') summary.bids_marked_lost++;
              continue;
            }
            // Sem valor capturado: nao chuta. >24h vira 'indeterminado' (admin
            // confere); mais novo continua pendente pra tentar de novo.
            const benchmark = b.auction_end_date ? new Date(b.auction_end_date).getTime() : new Date(b.created_at || Date.now()).getTime();
            const ageHours = (Date.now() - benchmark) / 3600000;
            if (ageHours > 24) {
              await pool.query(
                `UPDATE bids SET outcome='indeterminado', reconciled_at=NOW() WHERE id=$1`,
                [b.id]
              );
              summary.bids_indeterminate = (summary.bids_indeterminate || 0) + 1;
            } else {
              summary.bids_still_pending++;
            }
          }
          continue;
        }

        // 4. Pra cada lance no nosso banco desse anuncio: marca como venceu/perdeu
        for (const b of bids) {
          // Cliente VE o valor com spread; Dealers gravou sem spread.
          // Compara o valor SEM spread com o vencedor da Dealers (tolerancia R$ 0,50).
          const ourRealValue = removeSpread(b.bid_value);
          const won = Math.abs(ourRealValue - winningValue) < 0.5 || ourRealValue >= winningValue;
          if (won) {
            // payment_deadline = auction_end + 5min. Se auction_end nao existir
            // (legado), usa NOW + 5min como fallback.
            const endMs = b.auction_end_date ? new Date(b.auction_end_date).getTime() : Date.now();
            const deadline = new Date(endMs + 5 * 60 * 1000);
            await pool.query(
              `UPDATE bids SET outcome='venceu', final_price=$1, won_at=NOW(), reconciled_at=NOW(), payment_deadline=$2 WHERE id=$3`,
              [winningValue, deadline, b.id]
            );
            summary.bids_marked_won++;
            // Cria purchase ligada (idempotente: nao duplica se ja existe bid_id)
            const created = await ensurePurchaseFromWonBid(b, winningValue);
            if (created) summary.purchases_created++;
            // Envia email pra cliente AVISANDO que ganhou (assincrono, nao bloqueia)
            notifyWinner(b, winningValue, deadline).catch(e => console.error('[reconcile] email vencedor falhou:', e.message));
          } else {
            await pool.query(
              `UPDATE bids SET outcome='perdeu', final_price=$1, reconciled_at=NOW() WHERE id=$2`,
              [winningValue, b.id]
            );
            summary.bids_marked_lost++;
          }
        }
      } catch (err) {
        summary.errors.push({ advertisement_id: adId, message: err.message });
        // Deixa esses bids no estado "pendente"; tenta de novo no proximo ciclo
        summary.bids_still_pending += bids.length;
      }
    }
    lastSummary = summary;
    return summary;
  } finally {
    running = false;
    lastRunAt = new Date();
  }
}

/**
 * Cria uma linha em purchases pro lance vencedor. Liga via purchases.bid_id.
 * Idempotente: se ja existe purchase com esse bid_id, retorna false.
 * Status inicial: 'aguardando_aprovacao_admin' — o admin precisa conferir com
 * a Dealers antes do veiculo virar estoque oficial.
 */
async function ensurePurchaseFromWonBid(bid, finalPrice) {
  // Ja existe?
  const exists = await pool.query('SELECT id FROM purchases WHERE bid_id = $1', [bid.id]);
  if (exists.rows.length > 0) return false;

  let snap = {};
  try { snap = bid.vehicle_snapshot ? (typeof bid.vehicle_snapshot === 'string' ? JSON.parse(bid.vehicle_snapshot) : bid.vehicle_snapshot) : {}; }
  catch (e) { snap = {}; }
  const yearStr = snap.year_manufacture && snap.year_model
    ? `${snap.year_manufacture}/${snap.year_model}`
    : (snap.year_model || snap.year_manufacture || '');

  await pool.query(
    `INSERT INTO purchases (
       brand, model, version, year, km, color, fuel, transmission, city,
       status, notes, price, fipe_price, image, photos, bid_id, purchase_date
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,
       $10,$11,$12,$13,$14,$15,$16,$17
     )`,
    [
      snap.brand || bid.vehicle_brand || '',
      snap.model || bid.vehicle_model || '',
      snap.version || '',
      yearStr,
      parseInt(snap.km) || 0,
      snap.color || '',
      '',
      '',
      snap.location ? String(snap.location).split('\n')[0] : '',
      'aguardando_aprovacao_admin',
      `Compra automatica via lance vencedor (bid #${bid.id}). Aguardando confirmacao com a Dealers.`,
      finalPrice,
      0,
      snap.photo || null,
      snap.photo ? JSON.stringify([snap.photo]) : null,
      bid.id,
      new Date().toISOString().split('T')[0]
    ]
  );
  return true;
}

// Dispara email pro cliente vencedor + marca notified_winner_at pra nao
// duplicar. Pega dados de pagamento de platform_settings (CNPJ/PIX do dono).
async function notifyWinner(bid, finalPrice, deadline) {
  // Idempotencia: se ja avisamos, nao manda de novo
  const check = await pool.query('SELECT notified_winner_at, user_id FROM bids WHERE id = $1', [bid.id]);
  if (!check.rows.length) return;
  if (check.rows[0].notified_winner_at) return;
  const userId = check.rows[0].user_id;
  if (!userId) return;
  const userRes = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [userId]);
  if (!userRes.rows.length || !userRes.rows[0].email) return;

  // Dados de pagamento (CNPJ/PIX do dono)
  const PAY_KEYS = ['pay_razao_social', 'pay_cnpj', 'pay_banco', 'pay_agencia', 'pay_conta', 'pay_pix_key', 'pay_pix_tipo', 'pay_observacoes'];
  const payRes = await pool.query(`SELECT key, value FROM platform_settings WHERE key = ANY($1)`, [PAY_KEYS]);
  const payment = {};
  payRes.rows.forEach(r => { payment[r.key] = r.value || ''; });

  const enrichedBid = Object.assign({}, bid, { final_price: finalPrice, payment_deadline: deadline });
  try {
    await email.sendWinnerEmail(enrichedBid, userRes.rows[0], payment);
    await pool.query('UPDATE bids SET notified_winner_at = NOW() WHERE id = $1', [bid.id]);
    console.log('[reconcile] email vencedor enviado pra', userRes.rows[0].email, '(bid', bid.id + ')');
  } catch (err) {
    console.error('[reconcile] email falhou:', err.message);
  }
}

// ============================================================================
// VIGIA DE FECHAMENTO
// ----------------------------------------------------------------------------
// Roda com frequencia alta (a cada ~20s via server.js). Olha os lances que
// estao NA JANELA de fechamento (leilao acaba nos proximos minutos OU acabou de
// fechar) e, ENQUANTO a Dealers ainda devolve as ofertas, grava o maior lance
// visto em last_leading_value. Quando o lote fecha e some do feed, a
// reconciliacao usa esse ultimo valor pra decidir o vencedor na hora — em vez
// de perguntar pra Dealers depois (que responde vazio).
//
// Sem isso, o resultado do leilao se perdia no fechamento (bug do Douglas).
let capturing = false;
async function captureClosingWinners() {
  if (capturing) return { skipped: true };
  capturing = true;
  const stat = { ads_checked: 0, bids_updated: 0, errors: 0 };
  try {
    // Janela: leiloes fechando nos proximos 5min OU que fecharam nos ultimos
    // 30min (grace pra pegar o valor final antes do lote sumir do feed).
    const now = Date.now();
    const from = new Date(now - 30 * 60 * 1000);
    const to = new Date(now + 5 * 60 * 1000);
    const res = await pool.query(
      `SELECT id, advertisement_id, bid_value, auction_end_date, last_leading_value,
              user_id, user_name, user_email, vehicle_brand, vehicle_model, vehicle_snapshot
       FROM bids
       WHERE outcome IS NULL
         AND advertisement_id IS NOT NULL
         AND auction_end_date IS NOT NULL
         AND auction_end_date BETWEEN $1 AND $2`,
      [from, to]
    );
    if (!res.rows.length) return stat;

    // Agrupa por anuncio (1 chamada por lote)
    const byAd = new Map();
    for (const b of res.rows) {
      if (!byAd.has(b.advertisement_id)) byAd.set(b.advertisement_id, []);
      byAd.get(b.advertisement_id).push(b);
    }

    for (const [adId, bidsOfAd] of byAd.entries()) {
      try {
        stat.ads_checked++;
        const offers = await dealers.getOffers(String(adId));
        let maxVal = 0;
        if (Array.isArray(offers) && offers.length > 0) {
          maxVal = offers.reduce((mx, o) => {
            const v = parseFloat(o.price || o.value || 0);
            return v > mx ? v : mx;
          }, 0);
        }
        if (maxVal > 0) {
          // Dealers ainda tem oferta (leilao vivo/recem-fechado): grava o lider.
          for (const b of bidsOfAd) {
            await pool.query(
              `UPDATE bids SET last_leading_value=$1, last_leading_at=NOW() WHERE id=$2`,
              [maxVal, b.id]
            );
            stat.bids_updated++;
          }
        } else {
          // Dealers vazia = lote saiu do feed (fechou). Se ja passou do
          // fechamento (30s de grace) e temos o lider capturado, FINALIZA NA
          // HORA — dispara o vencedor + 10% sem esperar o cron de 60s.
          for (const b of bidsOfAd) {
            const ended = b.auction_end_date && (now - new Date(b.auction_end_date).getTime()) > 30 * 1000;
            const lead = parseFloat(b.last_leading_value);
            if (ended && lead && lead > 0) {
              const r = await finalizeBidFromValue(b, lead);
              if (r) { stat.finalized = (stat.finalized || 0) + 1; }
            }
          }
        }
      } catch (e) {
        stat.errors++;
      }
    }
    return stat;
  } finally {
    capturing = false;
  }
}

// Decide vencedor/perdedor a partir de um valor vencedor (SEM spread, da
// Dealers) e dispara o fluxo. Idempotente: o UPDATE so pega bids com
// outcome IS NULL, entao rodar de reconcile E do vigia ao mesmo tempo nao
// duplica. Usado pelos dois pra ter UMA logica so.
async function finalizeBidFromValue(b, winValue) {
  const ourRealValue = removeSpread(b.bid_value);
  const won = Math.abs(ourRealValue - winValue) < 0.5 || ourRealValue >= winValue;
  if (won) {
    const endMs = b.auction_end_date ? new Date(b.auction_end_date).getTime() : Date.now();
    const deadline = new Date(endMs + 5 * 60 * 1000);
    const upd = await pool.query(
      `UPDATE bids SET outcome='venceu', final_price=$1, won_at=NOW(), reconciled_at=NOW(), payment_deadline=$2 WHERE id=$3 AND outcome IS NULL RETURNING id`,
      [winValue, deadline, b.id]
    );
    if (upd.rows.length === 0) return null; // ja foi finalizado por outro ciclo
    await ensurePurchaseFromWonBid(b, winValue);
    notifyWinner(b, winValue, deadline).catch(e => console.error('[finalize] email vencedor falhou:', e.message));
    return 'venceu';
  }
  const upd = await pool.query(
    `UPDATE bids SET outcome='perdeu', final_price=$1, reconciled_at=NOW() WHERE id=$2 AND outcome IS NULL RETURNING id`,
    [winValue, b.id]
  );
  return upd.rows.length ? 'perdeu' : null;
}

function getStatus() {
  return { running, lastRunAt, lastSummary };
}

module.exports = { reconcileOnce, getStatus, captureClosingWinners };
