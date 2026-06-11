/* =====================================================================
 * LancePrime — Camada de dados (Store)
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
  var KEY = 'lance:v1';

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

  /* Estoque do LancePrime. Começa VAZIO — o dono cadastra os próprios
     veículos pelo painel (/admin). Pra publicar no site público (que lê do
     catálogo), os veículos entram aqui ou via backend, no deploy. */
  function seed() {
    return [];
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
        id: uid(), type: 'Carro', brand: '', model: '', year: '', km: 0, color: '', cc: 0,
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
