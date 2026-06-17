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

const GRACE_AFTER_END_MS = 2 * 60 * 1000; // 2 min: tempo do lance-relampago + folga
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
    // 1. Lances pendentes cujo leilao ja deveria ter fechado
    const cutoff = new Date(Date.now() - GRACE_AFTER_END_MS);
    const pendingRes = await pool.query(
      `SELECT id, user_id, advertisement_id, bid_value, bid_type, auction_end_date, vehicle_snapshot
       FROM bids
       WHERE outcome IS NULL
         AND auction_end_date IS NOT NULL
         AND auction_end_date <= $1
       ORDER BY auction_end_date ASC`,
      [cutoff]
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
          // Nao conseguiu apurar — deixa pra proxima rodada
          summary.bids_still_pending += bids.length;
          continue;
        }

        // 4. Pra cada lance no nosso banco desse anuncio: marca como venceu/perdeu
        for (const b of bids) {
          // Cliente VE o valor com spread; Dealers gravou sem spread.
          // Compara o valor SEM spread com o vencedor da Dealers (tolerancia R$ 0,50).
          const ourRealValue = removeSpread(b.bid_value);
          const won = Math.abs(ourRealValue - winningValue) < 0.5 || ourRealValue >= winningValue;
          if (won) {
            await pool.query(
              `UPDATE bids SET outcome='venceu', final_price=$1, won_at=NOW(), reconciled_at=NOW() WHERE id=$2`,
              [winningValue, b.id]
            );
            summary.bids_marked_won++;
            // Cria purchase ligada (idempotente: nao duplica se ja existe bid_id)
            const created = await ensurePurchaseFromWonBid(b, winningValue);
            if (created) summary.purchases_created++;
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

function getStatus() {
  return { running, lastRunAt, lastSummary };
}

module.exports = { reconcileOnce, getStatus };
