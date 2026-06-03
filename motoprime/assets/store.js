/* =====================================================================
 * QAVAH Multimarcas — Camada de dados (Store)
 * ---------------------------------------------------------------------
 * - O CATÁLOGO (seed) é a fonte da verdade do que aparece no site público.
 *   O site lê direto do catálogo (catalog()), então toda atualização que
 *   publicamos aparece na hora — sem depender do localStorage do visitante.
 * - O PAINEL (admin) trabalha sobre o localStorage (editável), semeado a
 *   partir do catálogo na primeira vez.
 *
 * Modelo: { id, type, brand, model, year, km, color, cc, fuel, start,
 *   plate, buyPrice, salePrice, refPrice, status, highlight, photos[],
 *   notes, costs[], createdAt }
 * ===================================================================== */
(function () {
  var KEY = 'qavah:v2';

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

  /* monta os caminhos das fotos de uma moto (na ordem dada). */
  function fotos(folder, order) {
    return order.map(function (n) { return 'assets/fotos/' + folder + '/' + n + '.jpg'; });
  }

  /* Estoque real da QAVAH Multimarcas (Betim/MG). Preço "Sob consulta"
     (negociado no chat) → salePrice 0. O Junior ajusta preço/compra/custos
     no painel. As 3 capas de painel foram reordenadas (foto da moto na frente). */
  function seed() {
    var t = Date.now();
    function item(o) {
      return Object.assign({
        id: '', type: 'Moto', km: 0, cc: 0, fuel: 'Gasolina', start: 'Elétrica',
        color: '', plate: '', buyPrice: 0, salePrice: 0, refPrice: 0,
        status: 'disponivel', highlight: false, photos: [], notes: '', costs: [], createdAt: t--
      }, o);
    }
    return [
      item({ id: 'twister-300-2026', brand: 'Honda', model: 'Twister 300', year: '2026', km: 800, cc: 300, color: 'Vermelha', highlight: true,
             photos: fotos('twister-300-2026', [1, 2, 3]),
             notes: 'Praticamente zero (800 km). Motor 300cc potente; design esportivo; conforto e estabilidade; cidade e estrada. Documentação em dia. Financiamento facilitado, aprovação rápida (autônomo e assalariado).' }),
      item({ id: 'nxr-160-bros-2025', brand: 'Honda', model: 'NXR 160 Bros', year: '2025', km: 0, cc: 160, color: 'Vermelha', highlight: true,
             photos: fotos('bros-160-2025', [1, 2, 3, 4, 5]),
             notes: '0 km. Design moderno, mais tecnologia. Motor 160cc potente e econômico; injeção eletrônica; suspensão alta e reforçada; freios eficientes. Cidade, estrada e terreno irregular.' }),
      item({ id: 'lander-250-2024', brand: 'Yamaha', model: 'Lander 250', year: '2024', km: 0, cc: 250, color: 'Azul', highlight: true,
             photos: fotos('lander-250-2024', [1, 2, 3, 4, 5]),
             notes: 'Yamaha Lander XTZ 250 — trail robusta pra cidade, estrada e off-road. Motor 250cc, suspensão alta, ótima posição de pilotagem. Aceita troca e financiamento.' }),
      item({ id: 'fan-cg-160-2026', brand: 'Honda', model: 'Fan / CG 160', year: '2026', km: 10000, cc: 160, color: 'Vermelha', highlight: true,
             photos: fotos('fan-cg-160-2026', [1, 2]),
             notes: 'Toda revisada, garantia de motor e caixa. Econômica. Financiamento por todos os bancos, em até 48x, com ou sem entrada (depende do CPF). Sujeito a aprovação de crédito.' }),
      item({ id: 'start-160-0km', brand: 'Honda', model: 'Start 160', year: '2025', km: 0, cc: 160, color: 'Vermelha',
             photos: fotos('sart-160-0-km', [1, 2, 3]),
             notes: 'Honda Start 160 0 km. Econômica e confiável pro dia a dia. Financiamento facilitado, aceita troca.' }),
      item({ id: 'start-160-2026', brand: 'Honda', model: 'Start 160', year: '2026', km: 0, cc: 160,
             photos: fotos('start-2026', [2, 3, 4, 1]),
             notes: 'Honda Start 160 seminova, pouquíssimo rodada. Econômica e pronta pra rodar. Documentação em dia, aceita troca e financiamento.' }),
      item({ id: 'start-160-2022', brand: 'Honda', model: 'Start 160', year: '2022', km: 0, cc: 160, color: 'Preta',
             photos: fotos('start-160-2022', [1, 2]),
             notes: 'Econômica, confiável, pro dia a dia ou trabalho. Motor 160cc forte e econômico; baixo consumo; manutenção simples e barata. Documentação em dia. Financiamento em até 48x. Entrada facilitada.' }),
      item({ id: 'bros-160-2021', brand: 'Honda', model: 'Bros 160', year: '2021', km: 49000, cc: 160, color: 'Azul',
             photos: fotos('bros-160-2021', [1, 2, 3, 4, 5]),
             notes: 'Revisada. Pega usada na troca. Financiamento em até 60x, com ou sem entrada (depende do CPF).' }),
      item({ id: 'bros-160-2016', brand: 'Honda', model: 'Bros 160', year: '2016', km: 60168, cc: 160, color: 'Preta',
             photos: fotos('bros-2016', [2, 3, 1]),
             notes: 'Ótimo estado de conservação. Motor 160cc forte e econômico; partida elétrica; suspensão alta e confortável; ótima para cidade e estrada de chão; baixo custo de manutenção. Documentação em dia.' }),
      item({ id: 'factor-150', brand: 'Yamaha', model: 'Factor 150', year: '', km: 0, cc: 150, color: 'Vermelha',
             photos: fotos('faactor-150', [1, 2, 3, 4, 5]),
             notes: 'Econômica, forte e confortável. Motor 150cc confiável; leve para pilotar; cidade ou estrada. Documentação em dia. Entrada facilitada. Financia em até 48x. Aceita usada na troca.' }),
      item({ id: 'fz15-2024', brand: 'Yamaha', model: 'FZ15', year: '2024', km: 25158, cc: 150, color: 'Azul',
             photos: fotos('fa15-2024', [2, 3, 4, 5, 1]),
             notes: 'Yamaha FZ15 2024, 25.158 km, com ABS. Econômica, ágil e moderna. Documentação em dia, aceita troca e financiamento.' }),
      item({ id: 'fiat-mobi-like-2023', type: 'Carro', brand: 'Fiat', model: 'Mobi Like', year: '2023', km: 34579, cc: 0, fuel: 'Flex', start: '',
             notes: 'Versão Like. Econômico no consumo e na manutenção; ágil e fácil de estacionar; ideal para uso urbano. Muito bem cuidado, pronto pra rodar.' }),
      item({ id: 'honda-civic-2007', type: 'Carro', brand: 'Honda', model: 'Civic', year: '2007', km: 0, cc: 0, fuel: 'Flex', start: '',
             notes: 'Excelente estado. Motor forte e econômico; câmbio macio; interior espaçoso; ar-condicionado gelando; direção hidráulica; vidros e travas elétricas. Durável e baixa manutenção. Documentação em dia. Pronto para transferência.' })
    ];
  }

  /* Catálogo (público) — cacheado por carregamento de página, IDs estáveis. */
  var _catalog = null;
  function catalog() { if (!_catalog) _catalog = seed(); return _catalog; }

  /* Lucro = venda − compra − custos. */
  function totalCosts(m) { return (m.costs || []).reduce(function (s, c) { return s + (Number(c.amount) || 0); }, 0); }
  function profit(m) { return (Number(m.salePrice) || 0) - (Number(m.buyPrice) || 0) - totalCosts(m); }

  window.MotoStore = {
    uid: uid,
    totalCosts: totalCosts,
    profit: profit,

    /* ---- Catálogo público (sempre fresco do deploy) ---- */
    catalog: catalog,
    catalogGet: function (id) { var l = catalog(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; },

    /* ---- Painel (localStorage) ---- */
    list: function () { return load(); },
    listPublic: function () { return load().filter(function (m) { return m.status !== 'vendida'; }); },
    get: function (id) { return load().filter(function (m) { return m.id === id; })[0] || null; },

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
    remove: function (id) { save(load().filter(function (m) { return m.id !== id; })); },

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

    reset: function () { localStorage.removeItem(KEY); return load(); }
  };
})();
