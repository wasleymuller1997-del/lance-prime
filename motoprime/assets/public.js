/* =====================================================================
 * MotoPrime — lógica do site público
 * Lê do MotoStore (somente leitura), aplica a marca do config.js e
 * renderiza o estoque com filtros. Mostra SÓ o preço final — nada de
 * compra/custos/lucro (isso é exclusivo do painel admin).
 * ===================================================================== */
(function () {
  var C = window.MP_CONFIG, fmt = window.MP.fmt, fmtKm = window.MP.fmtKm;
  var state = { search: '', brand: '', type: '', sort: 'recent', galleryPhotos: [], galleryIdx: 0 };

  function waLink(text) {
    return 'https://wa.me/' + C.whatsapp + '?text=' + encodeURIComponent(text);
  }

  /* Aplica cores + textos da marca em runtime. */
  function applyBrand() {
    var root = document.documentElement.style;
    root.setProperty('--primary', C.colors.primary);
    root.setProperty('--accent', C.colors.accent);
    root.setProperty('--bg', C.colors.bg);
    root.setProperty('--card', C.colors.card);
    document.title = C.brand + ' — Motos premium';
    window.MP.applyLogo();
    var wa = waLink('Olá! Vim pelo site da ' + C.brand + ' e gostaria de saber mais sobre as motos.');
    ['nav-wa', 'hero-wa', 'wa-float'].forEach(function (id) { var e = document.getElementById(id); if (e) e.href = wa; });
    document.getElementById('ft-phone').innerHTML = '<i class="fas fa-phone" style="color:var(--accent)"></i> ' + C.phone;
    document.getElementById('ft-email').innerHTML = '<i class="fas fa-envelope" style="color:var(--accent)"></i> ' + C.email;
    document.getElementById('ft-insta').innerHTML = '<i class="fab fa-instagram" style="color:var(--accent)"></i> ' + C.instagram;
  }

  function photoOf(m, i) {
    var p = (m.photos || [])[i || 0];
    return p && p.trim() ? p : window.MP.placeholder(m.brand + ' ' + m.model);
  }

  function statusLabel(s) {
    return s === 'reservada' ? 'Reservada' : s === 'vendida' ? 'Vendida' : 'Disponível';
  }
  /* Catálogo não publica preço → "Sob consulta". */
  function priceText(m) { return Number(m.salePrice) > 0 ? fmt(m.salePrice) : 'Sob consulta'; }

  function filtered() {
    var list = window.MotoStore.listPublic();
    var q = state.search.trim().toLowerCase();
    if (q) list = list.filter(function (m) { return (m.brand + ' ' + m.model).toLowerCase().indexOf(q) >= 0; });
    if (state.brand) list = list.filter(function (m) { return m.brand === state.brand; });
    if (state.type) list = list.filter(function (m) { return (m.type || 'Moto') === state.type; });
    list.sort(function (a, b) {
      switch (state.sort) {
        case 'price-asc': return (a.salePrice || 0) - (b.salePrice || 0);
        case 'price-desc': return (b.salePrice || 0) - (a.salePrice || 0);
        case 'km-asc': return (a.km || 0) - (b.km || 0);
        default: return (b.createdAt || 0) - (a.createdAt || 0);
      }
    });
    // destaques primeiro (só quando ordenação é "recentes")
    if (state.sort === 'recent') list.sort(function (a, b) { return (b.highlight ? 1 : 0) - (a.highlight ? 1 : 0); });
    return list;
  }

  function card(m) {
    var pv = Number(m.salePrice) > 0;
    var specs = [m.type, m.year, (m.km > 0 ? fmtKm(m.km) : ''), (m.cc ? m.cc + 'cc' : ''), m.color].filter(Boolean);
    return '' +
      '<article class="moto-card" onclick="MPUI.openModal(\'' + m.id + '\')">' +
      '  <div class="ph">' +
      (m.highlight ? '<span class="badge fav" style="background:var(--grad);color:#0a0a0a"><i class="fas fa-star"></i> Destaque</span>' : '') +
      '    <span class="badge st ' + m.status + '">' + statusLabel(m.status) + '</span>' +
      '    <img loading="lazy" src="' + photoOf(m) + '" alt="' + m.brand + ' ' + m.model + '">' +
      '  </div>' +
      '  <div class="body">' +
      '    <div class="ttl">' + m.brand + ' ' + m.model + '</div>' +
      '    <div class="sub">' + (m.year || 'Consulte o ano') + (m.color ? ' · ' + m.color : '') + '</div>' +
      '    <div class="specs">' + specs.map(function (s) { return '<span>' + s + '</span>'; }).join('') + '</div>' +
      '    <div class="price"><div><small>Preço</small><div class="v grad-text" style="' + (pv ? '' : 'font-size:1.05rem') + '">' + priceText(m) + '</div></div>' +
      '      <span class="btn ghost" style="padding:8px 12px;font-size:.78rem">Ver <i class="fas fa-arrow-right"></i></span>' +
      '    </div>' +
      '  </div>' +
      '</article>';
  }

  function render() {
    var list = filtered();
    var grid = document.getElementById('grid');
    grid.innerHTML = list.length
      ? list.map(card).join('')
      : '<div class="empty" style="grid-column:1/-1"><i class="fas fa-motorcycle" style="font-size:2rem;opacity:.4"></i><p style="margin-top:10px">Nenhum veículo encontrado com esses filtros.</p></div>';
    document.getElementById('count').textContent = list.length + (list.length === 1 ? ' veículo' : ' veículos');
  }

  function renderHeader() {
    var all = window.MotoStore.listPublic();
    document.getElementById('st-total').textContent = all.length;
    // popular filtro de marcas
    var brands = all.map(function (m) { return m.brand; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; }).sort();
    var sel = document.getElementById('f-brand');
    sel.innerHTML = '<option value="">Todas as marcas</option>' + brands.map(function (b) { return '<option value="' + b + '">' + b + '</option>'; }).join('');
  }

  /* ---- Modal de detalhe ---- */
  function openModal(id) {
    var m = window.MotoStore.get(id);
    if (!m) return;
    state.galleryPhotos = (m.photos && m.photos.length ? m.photos : [photoOf(m)]);
    state.galleryIdx = 0;
    document.getElementById('m-img').src = state.galleryPhotos[0];
    var hasMany = state.galleryPhotos.length > 1;
    document.querySelectorAll('#m-gallery .nav').forEach(function (n) { n.style.display = hasMany ? 'grid' : 'none'; });
    document.getElementById('m-title').textContent = m.brand + ' ' + m.model;
    document.getElementById('m-sub').textContent = [m.type, m.year, m.color].filter(Boolean).join(' · ');
    var st = document.getElementById('m-status');
    st.className = 'badge ' + m.status; st.textContent = statusLabel(m.status);
    var specs = [['Tipo', m.type || '—'], ['Ano', m.year || '—'], ['KM', m.km > 0 ? fmtKm(m.km) : '—']];
    if (m.cc) specs.push(['Cilindrada', m.cc + ' cc']);
    specs.push(['Combustível', m.fuel || '—']);
    if (m.start) specs.push(['Partida', m.start]);
    specs.push(['Cor', m.color || '—']);
    document.getElementById('m-specs').innerHTML = specs.map(function (s) {
      return '<div class="it"><small>' + s[0] + '</small><b>' + s[1] + '</b></div>';
    }).join('');
    document.getElementById('m-notes').textContent = m.notes || '';
    document.getElementById('m-price').textContent = priceText(m);
    var pinfo = Number(m.salePrice) > 0 ? ' (' + fmt(m.salePrice) + ')' : '';
    document.getElementById('m-wa').href = waLink('Olá! Tenho interesse no ' + m.brand + ' ' + m.model + ' ' + (m.year || '') + pinfo + ' anunciado no site da ' + C.brand + '.');
    document.getElementById('modal').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() { document.getElementById('modal').classList.remove('open'); document.body.style.overflow = ''; }
  function galNav(d) {
    var n = state.galleryPhotos.length; if (!n) return;
    state.galleryIdx = (state.galleryIdx + d + n) % n;
    document.getElementById('m-img').src = state.galleryPhotos[state.galleryIdx];
  }

  window.MPUI = { openModal: openModal, closeModal: closeModal, galNav: galNav };

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  document.addEventListener('DOMContentLoaded', function () {
    applyBrand();
    renderHeader();
    render();
    document.getElementById('f-search').addEventListener('input', function (e) { state.search = e.target.value; render(); });
    document.getElementById('f-brand').addEventListener('change', function (e) { state.brand = e.target.value; render(); });
    var ft = document.getElementById('f-type');
    if (ft) ft.addEventListener('change', function (e) { state.type = e.target.value; render(); });
    document.getElementById('f-sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });
  });
})();
