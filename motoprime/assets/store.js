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
  var KEY = 'motoprime:v1';

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

  function seed() {
    var now = Date.now();
    function moto(o) {
      return Object.assign({
        id: uid(), km: 0, cc: 0, fuel: 'Gasolina', start: 'Elétrica',
        plate: '', refPrice: 0, status: 'disponivel', highlight: false,
        photos: [], notes: '', costs: [], createdAt: now--
      }, o);
    }
    return [
      moto({ brand: 'Honda', model: 'CB 500F', year: '2023', km: 8200, cc: 471, color: 'Vermelha',
             buyPrice: 32000, salePrice: 39900, refPrice: 41000, highlight: true,
             costs: [{ id: uid(), category: 'Revisão', description: 'Revisão completa + óleo', amount: 850, date: '2026-05-10' },
                     { id: uid(), category: 'Documentação', description: 'Transferência', amount: 600, date: '2026-05-12' }] }),
      moto({ brand: 'Yamaha', model: 'MT-03', year: '2022', km: 14500, cc: 321, color: 'Azul',
             buyPrice: 26000, salePrice: 32500, refPrice: 33000, highlight: true,
             costs: [{ id: uid(), category: 'Estética', description: 'Polimento e limpeza', amount: 300, date: '2026-05-08' }] }),
      moto({ brand: 'Kawasaki', model: 'Z400', year: '2021', km: 19800, cc: 399, color: 'Verde',
             buyPrice: 24000, salePrice: 29900, refPrice: 30500,
             costs: [{ id: uid(), category: 'Reparo', description: 'Pneu traseiro', amount: 720, date: '2026-04-28' }] }),
      moto({ brand: 'Honda', model: 'XRE 300', year: '2023', km: 6100, cc: 291, color: 'Preta',
             buyPrice: 23000, salePrice: 28900, refPrice: 29500, highlight: true, costs: [] }),
      moto({ brand: 'Yamaha', model: 'Fazer 250', year: '2020', km: 27300, cc: 249, color: 'Branca',
             buyPrice: 15000, salePrice: 18900, refPrice: 19000, status: 'reservada', costs: [] }),
      moto({ brand: 'BMW', model: 'G 310 R', year: '2022', km: 11200, cc: 313, color: 'Cinza',
             buyPrice: 27000, salePrice: 33900, refPrice: 34500, costs: [] })
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
        id: uid(), brand: '', model: '', year: '', km: 0, color: '', cc: 0,
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
