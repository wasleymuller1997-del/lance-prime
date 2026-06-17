/**
 * Gerador de BR Code PIX (string "copia e cola" + dado pra QR).
 *
 * Sem libs externas — implementa a especificacao oficial do Bacen
 * (Manual de Padroes do BR Code). E TLV com CRC16-CCITT-FALSE no fim.
 *
 * Uso:
 *   const code = brCode({
 *     pixKey: '54399844000186',
 *     name: 'Solucoes Tecnologicas WM',
 *     city: 'BETIM',
 *     amount: 5600.00,
 *     txid: 'BID42'
 *   });
 *   // string "00020126..." pronta pra copia/cola E pra encodar em QR.
 */

function field(id, value) {
  const v = String(value);
  const len = String(v.length).padStart(2, '0');
  return id + len + v;
}

// Sanitiza nome/cidade pra ASCII basico (PIX nao aceita acento/simbolo e exige
// limite de comprimento: 25 pra merchant name, 15 pra cidade).
function sanitize(s, maxLen) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // tira acentos
    .replace(/[^a-zA-Z0-9 ]/g, '')                      // so alfanumerico + espaco
    .replace(/\s+/g, ' ').trim()
    .slice(0, maxLen)
    .toUpperCase();
}

// CRC16-CCITT-FALSE: poly 0x1021, init 0xFFFF, sem reflect. O padrao do PIX.
function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function brCode({ pixKey, name, city, amount, txid }) {
  if (!pixKey) throw new Error('brCode: pixKey obrigatoria');
  const cleanKey = String(pixKey).replace(/[^\w@\.\-]/g, '');
  const cleanName = sanitize(name || 'BENEFICIARIO', 25);
  const cleanCity = sanitize(city || 'BR', 15);
  const cleanAmount = (parseFloat(amount) > 0 ? parseFloat(amount).toFixed(2) : null);
  const cleanTxid = (String(txid || '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***');

  const merchantAccount = field('00', 'br.gov.bcb.pix') + field('01', cleanKey);
  const additionalData = field('05', cleanTxid);

  let payload =
    field('00', '01') +                  // Payload Format Indicator
    field('26', merchantAccount) +       // Merchant Account Info
    field('52', '0000') +                // Merchant Category Code (genericо)
    field('53', '986');                  // Currency = BRL
  if (cleanAmount) payload += field('54', cleanAmount); // valor estatico
  payload +=
    field('58', 'BR') +                  // Country
    field('59', cleanName) +             // Merchant Name
    field('60', cleanCity) +             // Merchant City
    field('62', additionalData);         // Reference Label / TXID

  // CRC16 e calculado sobre o payload + "6304" (ID 63 + len 04). Resultado
  // anexado no fim. Total final tem CRC sempre nos ultimos 4 chars.
  const withCrcMarker = payload + '6304';
  const crc = crc16(withCrcMarker);
  return withCrcMarker + crc;
}

module.exports = { brCode, sanitize, crc16 };
