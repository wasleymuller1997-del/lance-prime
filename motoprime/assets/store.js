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
  var KEY = 'qavah:v3';

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
      item({ id: 'honda-cg-160-fan-2026', brand: 'Honda', model: 'CG 160 Fan', year: '2026', km: 2620, cc: 160, color: 'Preto', fuel: 'Flex', salePrice: 22900, highlight: true,
             photos: ['assets/fotos/honda-cg-160-fan-2026/1.jpg', 'assets/fotos/honda-cg-160-fan-2026/2.jpg', 'assets/fotos/honda-cg-160-fan-2026/3.jpg', 'assets/fotos/honda-cg-160-fan-2026/4.jpg'],
             notes: 'Honda CG 160 Fan 2026 · 2.620 km · Preto. Revisada e pronta pra rodar. Documentação em dia, aceita troca e financiamento facilitado.' }),
      item({ id: 'honda-nxr160-bros-esdd-2024', brand: 'Honda', model: 'NXR 160 Bros', year: '2024', km: 20960, cc: 160, color: 'Branco', fuel: 'Flex', salePrice: 23900, highlight: true,
             photos: ['assets/fotos/honda-nxr160-bros-esdd-2024/1.jpg', 'assets/fotos/honda-nxr160-bros-esdd-2024/2.jpg', 'assets/fotos/honda-nxr160-bros-esdd-2024/3.jpg'],
             notes: 'Honda NXR 160 Bros 2024 · 20.960 km · Branco. Revisada e pronta pra rodar. Documentação em dia, aceita troca e financiamento facilitado.' }),
      item({ id: 'yamaha-fz15-fazer-abs-2024', brand: 'Yamaha', model: 'FZ15 Fazer', year: '2024', km: 40810, cc: 150, color: 'Azul', fuel: 'Flex', salePrice: 20900, highlight: true,
             photos: ['assets/fotos/yamaha-fz15-fazer-abs-2024/1.jpg', 'assets/fotos/yamaha-fz15-fazer-abs-2024/2.jpg', 'assets/fotos/yamaha-fz15-fazer-abs-2024/3.jpg'],
             notes: 'Yamaha FZ15 Fazer 2024 · 40.810 km · Azul. Revisada e pronta pra rodar. Documentação em dia, aceita troca e financiamento facilitado.' }),
      item({ id: 'yamaha-fz25-fazer-2021', brand: 'Yamaha', model: 'FZ25 Fazer', year: '2021', km: 35000, cc: 250, color: 'Vermelho', fuel: 'Flex', salePrice: 21900, highlight: true,
             photos: ['assets/fotos/yamaha-fz25-fazer-2021/1.jpg', 'assets/fotos/yamaha-fz25-fazer-2021/2.jpg', 'assets/fotos/yamaha-fz25-fazer-2021/3.jpg', 'assets/fotos/yamaha-fz25-fazer-2021/4.jpg'],
             notes: 'Yamaha FZ25 Fazer 2021 · 35.000 km · Vermelho. Revisada e pronta pra rodar. Documentação em dia, aceita troca e financiamento facilitado.' }),
      item({ id: 'honda-biz-110i-2016', brand: 'Honda', model: 'Biz 110i', year: '2016', km: 55790, cc: 110, color: 'Vermelho', fuel: 'Gasolina', salePrice: 12900, highlight: false,
             photos: ['assets/fotos/honda-biz-110i-2016/1.jpg'],
             notes: 'Honda Biz 110i 2016 · 55.790 km · Vermelho. Revisada e pronta pra rodar. Documentação em dia, aceita troca e financiamento facilitado.' }),
      item({ id: 'honda-biz-125-2021', brand: 'Honda', model: 'Biz 125', year: '2021', km: 35000, cc: 125, color: 'Branco', fuel: 'Flex', salePrice: 16900, highlight: false,
             photos: ['assets/fotos/honda-biz-125-2021/1.jpg', 'assets/fotos/honda-biz-125-2021/2.jpg', 'assets/fotos/honda-biz-125-2021/3.jpg'],
             notes: 'Honda Biz 125 2021 · 35.000 km · Branco. Revisada e pronta pra rodar. Documentação em dia, aceita troca e financiamento facilitado.' }),
      item({ id: 'honda-cg-150-titan-ex-2015', brand: 'Honda', model: 'CG 150 Titan EX', year: '2015', km: 108270, cc: 150, color: 'Branco', fuel: 'Flex', salePrice: 16900, highlight: false,
             photos: ['assets/fotos/honda-cg-150-titan-ex-2015/1.jpg', 'assets/fotos/honda-cg-150-titan-ex-2015/2.jpg', 'assets/fotos/honda-cg-150-titan-ex-2015/3.jpg', 'assets/fotos/honda-cg-150-titan-ex-2015/4.jpg', 'assets/fotos/honda-cg-150-titan-ex-2015/5.jpg'],
             notes: 'Honda CG 150 Titan EX 2015 · 108.270 km · Branco. Revisada e pronta pra rodar. Documentação em dia, aceita troca e financiamento facilitado.' }),
      item({ id: 'honda-cg-160-fan-2024', brand: 'Honda', model: 'CG 160 Fan', year: '2024', km: 20415, cc: 160, color: 'Preto', fuel: 'Flex', salePrice: 19900, highlight: false,
             photos: ['assets/fotos/honda-cg-160-fan-2024/1.jpg', 'assets/fotos/honda-cg-160-fan-2024/2.jpg', 'assets/fotos/honda-cg-160-fan-2024/3.jpg', 'assets/fotos/honda-cg-160-fan-2024/4.jpg'],
             notes: 'Honda CG 160 Fan 2024 · 20.415 km · Preto. Revisada e pronta pra rodar. Documentação em dia, aceita troca e financiamento facilitado.' })
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
