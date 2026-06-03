/* =====================================================================
 * MotoPrime — Configuração da marca (PLACEHOLDER)
 * ---------------------------------------------------------------------
 * TROQUE TUDO AQUI. Esse é o único arquivo que você precisa editar pra
 * dar a cara da agência do cliente: nome, cores, contato e WhatsApp.
 * Tanto o site público quanto o painel admin leem daqui.
 * ===================================================================== */
window.MP_CONFIG = {
  // --- Identidade ---
  brand: 'QAVAH',                   // nome da agência
  brandSuffix: 'Multimarcas',       // complemento do logo (texto menor)
  tagline: 'Multimarcas · motos premium',
  logo: '',                         // caminho do logo (ex: 'assets/logo.png'). Vazio = usa ícone.
  // --- Contato (aparece no site público) ---
  whatsapp: '5531995250756',        // Junior Silva — só números, com DDI 55 + DDD
  phone: '(31) 99525-0756',
  email: 'qavahmultimarcas@gmail.com',
  city: 'Betim - MG',
  instagram: '@qavahmultimarcas',   // ←confirme
  // --- Cores (dourado sobre preto, igual o logo) ---
  colors: {
    primary: '#c9a96e',             // dourado
    accent:  '#e8c87d',             // dourado claro
    bg:      '#0a0a0a',             // preto
    card:    '#15130f'              // grafite quente
  }
};

/* Helpers globais de formatação — usados nas duas telas. */
window.MP = window.MP || {};
window.MP.fmt = function (n) {
  n = Number(n) || 0;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
};
window.MP.fmtKm = function (n) {
  n = Number(n) || 0;
  return n.toLocaleString('pt-BR') + ' km';
};
/* Monta o "wordmark": QAVAH + MULTIMARCAS menorzinho ao lado. */
window.MP.brandMarkup = function () {
  var c = window.MP_CONFIG;
  var suf = c.brandSuffix ? ' <span class="brand-suffix">' + c.brandSuffix.toUpperCase() + '</span>' : '';
  return c.brand + suf;
};
/* Aplica nome, sufixo, logo (se houver) e cidade nos elementos marcados. */
window.MP.applyLogo = function () {
  var c = window.MP_CONFIG;
  [].forEach.call(document.querySelectorAll('[data-brand]'), function (el) { el.innerHTML = window.MP.brandMarkup(); });
  [].forEach.call(document.querySelectorAll('[data-tagline]'), function (el) { el.textContent = c.tagline; });
  [].forEach.call(document.querySelectorAll('[data-city]'), function (el) { el.textContent = c.city; });
  if (c.logo) {
    [].forEach.call(document.querySelectorAll('.logo .dot'), function (el) {
      el.style.background = 'none'; el.style.borderRadius = '6px';
      el.innerHTML = '<img src="' + c.logo + '" alt="' + c.brand + '" style="width:100%;height:100%;object-fit:contain">';
    });
  }
};

/* Placeholder de foto: SVG embutido (sempre renderiza, sem depender de rede). */
window.MP.placeholder = function (label) {
  var c = window.MP_CONFIG.colors;
  var txt = (label || 'MotoPrime').toString();
  var svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="' + c.primary + '"/>' +
    '<stop offset="1" stop-color="' + c.accent + '"/></linearGradient></defs>' +
    '<rect width="640" height="420" fill="#12152a"/>' +
    '<rect width="640" height="420" fill="url(#g)" opacity="0.12"/>' +
    '<text x="50%" y="48%" fill="#5a6080" font-family="Space Grotesk,Arial" ' +
    'font-size="26" font-weight="700" text-anchor="middle">' +
    txt.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</text>' +
    '<text x="50%" y="58%" fill="#3a4060" font-family="Arial" font-size="14" ' +
    'text-anchor="middle">sem foto</text></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
};
