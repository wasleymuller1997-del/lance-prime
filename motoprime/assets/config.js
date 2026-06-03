/* =====================================================================
 * MotoPrime — Configuração da marca (PLACEHOLDER)
 * ---------------------------------------------------------------------
 * TROQUE TUDO AQUI. Esse é o único arquivo que você precisa editar pra
 * dar a cara da agência do cliente: nome, cores, contato e WhatsApp.
 * Tanto o site público quanto o painel admin leem daqui.
 * ===================================================================== */
window.MP_CONFIG = {
  // --- Identidade ---
  brand: 'MotoPrime',               // nome da agência (placeholder)
  tagline: 'Motos premium, prontas pra rodar',
  // --- Contato (aparece no site público) ---
  whatsapp: '5551999999999',        // só números, com DDI 55 + DDD
  phone: '(51) 99999-9999',
  email: 'contato@motoprime.com.br',
  city: 'Porto Alegre - RS',
  instagram: '@motoprime',
  // --- Cores (gradiente da marca) ---
  colors: {
    primary: '#6c5ce7',             // roxo
    accent:  '#00cec9',             // ciano
    bg:      '#0b0d17',
    card:    '#12152a'
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
