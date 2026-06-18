// Estrutura canônica do álbum Copa do Mundo 2026 (Panini).
// FWC (20: 9 abertura + 11 Museu FIFA) + CC (14, Coca-Cola) + 48 seleções x 20
// = 994 figurinhas. A ORDEM segue o álbum físico (mesma dos apps de referência).
//
// As figurinhas são identificadas por CÓDIGO+NÚMERO (ex.: "MEX5", "FWC13").
// Este módulo é a fonte única usada pelo radar pra calcular o que falta a cada
// colecionador — o frontend tem a mesma lista (com nomes/bandeiras).

const SECTIONS = [
  { code: 'FWC', count: 20, start: 0 }, // FWC vai de 00 a 19 (inclui o "00" da Panini)
  { code: 'CC',  count: 14 },
  { code: 'MEX', count: 20 }, { code: 'RSA', count: 20 }, { code: 'KOR', count: 20 },
  { code: 'CZE', count: 20 }, { code: 'CAN', count: 20 }, { code: 'BIH', count: 20 },
  { code: 'QAT', count: 20 }, { code: 'SUI', count: 20 }, { code: 'BRA', count: 20 },
  { code: 'MAR', count: 20 }, { code: 'HAI', count: 20 }, { code: 'SCO', count: 20 },
  { code: 'USA', count: 20 }, { code: 'PAR', count: 20 }, { code: 'AUS', count: 20 },
  { code: 'TUR', count: 20 }, { code: 'GER', count: 20 }, { code: 'CUW', count: 20 },
  { code: 'CIV', count: 20 }, { code: 'ECU', count: 20 }, { code: 'NED', count: 20 },
  { code: 'JPN', count: 20 }, { code: 'SWE', count: 20 }, { code: 'TUN', count: 20 },
  { code: 'BEL', count: 20 }, { code: 'EGY', count: 20 }, { code: 'IRN', count: 20 },
  { code: 'NZL', count: 20 }, { code: 'ESP', count: 20 }, { code: 'CPV', count: 20 },
  { code: 'KSA', count: 20 }, { code: 'URU', count: 20 }, { code: 'FRA', count: 20 },
  { code: 'SEN', count: 20 }, { code: 'IRQ', count: 20 }, { code: 'NOR', count: 20 },
  { code: 'ARG', count: 20 }, { code: 'ALG', count: 20 }, { code: 'AUT', count: 20 },
  { code: 'JOR', count: 20 }, { code: 'POR', count: 20 }, { code: 'COD', count: 20 },
  { code: 'UZB', count: 20 }, { code: 'COL', count: 20 }, { code: 'ENG', count: 20 },
  { code: 'CRO', count: 20 }, { code: 'GHA', count: 20 }, { code: 'PAN', count: 20 },
];

const ALL_IDS = [];
SECTIONS.forEach((s) => {
  const start = s.start == null ? 1 : s.start;
  for (let i = start; i < start + s.count; i++) ALL_IDS.push(s.code + i);
});
const ID_SET = new Set(ALL_IDS);
const TOTAL = ALL_IDS.length; // 994

module.exports = { SECTIONS, ALL_IDS, ID_SET, TOTAL };
