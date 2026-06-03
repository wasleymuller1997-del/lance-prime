/* =====================================================================
 * MotoPrime — Camada de dados (Store)
 * ---------------------------------------------------------------------
 * ESTE É O "ENCAIXE" DO BACKEND. Hoje guarda tudo no navegador
 * (localStorage). Quando for pra full-stack, basta reescrever os métodos
 * abaixo pra chamar a API (fetch) — o resto do app (público e admin) não
 * muda, porque só conversa com window.MotoStore.
 *
 * Modelo de uma moto:
 * {
 *   id, brand, model, year, km, color, cc, fuel, start, plate,
 *   buyPrice,   // compra        (SÓ admin)
 *   salePrice,  // preço final   (aparece no site público)
 *   refPrice,   // tabela/FIPE    (SÓ admin, referência manual)
 *   status,     // 'disponivel' | 'reservada' | 'vendida'
 *   highlight,  // destaque no público (bool)
 *   photos: [url...], notes,
 *   costs: [{ id, category, description, amount, date }],
 *   createdAt
 * }
 * ===================================================================== */
(function () {
  var KEY = 'qavah:v1';

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignora corrupção */ }
    var seeded = seed();
    save(seeded);
    return seeded;
  }
  function save(list) { localStorage.setItem(KEY, JSON.stringify(list)); }

  /* Estoque real da QAVAH Multimarcas (catálogo WhatsApp, Betim/MG).
     Preços negociados no chat → salePrice 0 = "Sob consulta". O Junior
     ajusta preços, compra e custos pelo painel. */
  function seed() {
    var now = Date.now();
    function item(o) {
      return Object.assign({
        id: uid(), type: 'Moto', km: 0, cc: 0, fuel: 'Gasolina', start: 'Elétrica',
        color: '', plate: '', buyPrice: 0, salePrice: 0, refPrice: 0,
        status: 'disponivel', highlight: false, photos: [], notes: '', costs: [], createdAt: now--
      }, o);
    }
    return [
      item({ type: 'Moto', brand: 'Honda', model: 'Twister 300', year: '2026', km: 800, cc: 300, highlight: true,
             notes: 'Praticamente zero (800 km). Motor 300cc potente; design esportivo; conforto e estabilidade; cidade e estrada. Documentação em dia. Financiamento facilitado, aprovação rápida (autônomo e assalariado).' }),
      item({ type: 'Moto', brand: 'Honda', model: 'NXR 160 Bros', year: '2025', km: 0, cc: 160, highlight: true,
             notes: '0 km. Design moderno, mais tecnologia. Motor 160cc potente e econômico; injeção eletrônica; suspensão alta e reforçada; freios eficientes; painel moderno. Cidade, estrada e terreno irregular.' }),
      item({ type: 'Moto', brand: 'Honda', model: 'Fan / CG 160', year: '2026', km: 10000, cc: 160, highlight: true,
             notes: 'Toda revisada, garantia de motor e caixa. Econômica. Financiamento por todos os bancos, em até 48x, com ou sem entrada (depende do CPF). Sujeito a aprovação de crédito.' }),
      item({ type: 'Moto', brand: 'Honda', model: 'Start 160', year: '', km: 0, cc: 160,
             notes: 'Moto 0 km.' }),
      item({ type: 'Moto', brand: 'Honda', model: 'Start 160', year: '2022', km: 0, cc: 160,
             notes: 'Econômica, confiável, pro dia a dia ou trabalho. Motor 160cc forte e econômico; baixo consumo; manutenção simples e barata. Documentação em dia. Financiamento em até 48x. Entrada facilitada.' }),
      item({ type: 'Moto', brand: 'Honda', model: 'Bros 160', year: '2021', km: 49000, cc: 160,
             notes: 'Revisada. Pega usada na troca. Financiamento em até 60x, com ou sem entrada (depende do CPF).' }),
      item({ type: 'Moto', brand: 'Honda', model: 'Bros 160', year: '2016', km: 60168, cc: 160,
             notes: 'Ótimo estado de conservação. Motor 160cc forte e econômico; partida elétrica; suspensão alta e confortável; ótima para cidade e estrada de chão; baixo custo de manutenção. Documentação em dia.' }),
      item({ type: 'Moto', brand: 'Yamaha', model: 'Factor 150', year: '', km: 0, cc: 150,
             notes: 'Econômica, forte e confortável. Motor 150cc confiável; leve para pilotar; cidade ou estrada. Documentação em dia. Entrada facilitada. Financia em até 48x. Aceita usada na troca.' }),
      item({ type: 'Carro', brand: 'Fiat', model: 'Mobi Like', year: '2023', km: 34579, cc: 0, fuel: 'Flex', start: '',
             notes: 'Versão Like. Econômico no consumo e na manutenção; ágil e fácil de estacionar; ideal para uso urbano. Muito bem cuidado, pronto pra rodar.' }),
      item({ type: 'Carro', brand: 'Honda', model: 'Civic', year: '2007', km: 0, cc: 0, fuel: 'Flex', start: '',
             notes: 'Excelente estado. Motor forte e econômico; câmbio macio; interior espaçoso; ar-condicionado gelando; direção hidráulica; vidros e travas elétricas. Durável e baixa manutenção. Documentação em dia. Pronto para transferência.' })
    ];
  }

  /* Lucro de uma moto = venda − compra − custos. */
  function totalCosts(m) { return (m.costs || []).reduce(function (s, c) { return s + (Number(c.amount) || 0); }, 0); }
  function profit(m) { return (Number(m.salePrice) || 0) - (Number(m.buyPrice) || 0) - totalCosts(m); }

  window.MotoStore = {
    uid: uid,
    totalCosts: totalCosts,
    profit: profit,

    /* ---- Leitura ---- */
    list: function () { return load(); },
    listPublic: function () {            // o que o site público mostra
      return load().filter(function (m) { return m.status !== 'vendida'; });
    },
    get: function (id) { return load().filter(function (m) { return m.id === id; })[0] || null; },

    /* ---- Escrita (admin) ---- */
    add: function (data) {
      var list = load();
      var m = Object.assign({
        id: uid(), type: 'Moto', brand: '', model: '', year: '', km: 0, color: '', cc: 0,
        fuel: 'Gasolina', start: 'Elétrica', plate: '', buyPrice: 0, salePrice: 0,
        refPrice: 0, status: 'disponivel', highlight: false, photos: [], notes: '',
        costs: [], createdAt: Date.now()
      }, data);
      list.unshift(m);
      save(list);
      return m;
    },
    update: function (id, patch) {
      var list = load();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) { list[i] = Object.assign(list[i], patch); save(list); return list[i]; }
      }
      return null;
    },
    remove: function (id) {
      save(load().filter(function (m) { return m.id !== id; }));
    },

    /* ---- Custos ---- */
    addCost: function (id, cost) {
      var list = load();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
          list[i].costs = list[i].costs || [];
          list[i].costs.push(Object.assign({ id: uid(), date: new Date().toISOString().slice(0, 10) }, cost));
          save(list); return list[i];
        }
      }
      return null;
    },
    removeCost: function (id, costId) {
      var list = load();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) {
          list[i].costs = (list[i].costs || []).filter(function (c) { return c.id !== costId; });
          save(list); return list[i];
        }
      }
      return null;
    },

    /* ---- Utilitário: zera tudo e re-semeia (botão "dados de exemplo") ---- */
    reset: function () { localStorage.removeItem(KEY); return load(); }
  };
})();
