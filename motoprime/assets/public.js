/* =====================================================================
 * MotoPrime — lógica do site público
 * Lê do MotoStore (somente leitura), aplica a marca do config.js e
 * renderiza o estoque com filtros. Mostra SÓ o preço final — nada de
 * compra/custos/lucro (isso é exclusivo do painel admin).
 * ===================================================================== */
(function () {
  var C = window.MP_CONFIG, fmt = window.MP.fmt, fmtKm = window.MP.fmtKm;
  var state = { search: '', brand: '', sort: 'recent', galleryPhotos: [], galleryIdx: 0 };

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
    [].forEach.call(document.querySelectorAll('[data-brand]'), function (el) { el.textContent = C.brand; });
    [].forEach.call(document.querySelectorAll('[data-tagline]'), function (el) { el.textContent = C.tagline; });
    [].forEach.call(document.querySelectorAll('[data-city]'), function (el) { el.textContent = C.city; });
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

  function filtered() {
    var list = window.MotoStore.listPublic();
    var q = state.search.trim().toLowerCase();
    if (q) list = list.filter(function (m) { return (m.brand + ' ' + m.model).toLowerCase().indexOf(q) >= 0; });
    if (state.brand) list = list.filter(function (m) { return m.brand === state.brand; });
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
    var specs = [m.year, fmtKm(m.km), m.cc ? m.cc + 'cc' : '', m.color].filter(Boolean);
    return '' +
      '<article class="moto-card" onclick="MPUI.openModal(\'' + m.id + '\')">' +
      '  <div class="ph">' +
      (m.highlight ? '<span class="badge fav" style="background:var(--grad);color:#fff"><i class="fas fa-star"></i> Destaque</span>' : '') +
      '    <span class="badge st ' + m.status + '">' + statusLabel(m.status) + '</span>' +
      '    <img loading="lazy" src="' + photoOf(m) + '" alt="' + m.brand + ' ' + m.model + '">' +
      '  </div>' +
      '  <div class="body">' +
      '    <div class="ttl">' + m.brand + ' ' + m.model + '</div>' +
      '    <div class="sub">' + (m.year || '') + (m.color ? ' · ' + m.color : '') + '</div>' +
      '    <div class="specs">' + specs.map(function (s) { return '<span>' + s + '</span>'; }).join('') + '</div>' +
      '    <div class="price"><div><small>Preço final</small><div class="v grad-text">' + fmt(m.salePrice) + '</div></div>' +
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
      : '<div class="empty" style="grid-column:1/-1"><i class="fas fa-motorcycle" style="font-size:2rem;opacity:.4"></i><p style="margin-top:10px">Nenhuma moto encontrada com esses filtros.</p></div>';
    document.getElementById('count').textContent = list.length + (list.length === 1 ? ' moto' : ' motos');
  }

  function renderHeader() {
    var all = window.MotoStore.listPublic();
    document.getElementById('st-total').textContent = all.length;
    var min = all.reduce(function (m, v) { return v.salePrice && v.salePrice < m ? v.salePrice : m; }, Infinity);
    document.getElementById('st-from').textContent = isFinite(min) ? fmt(min) : 'R$ 0';
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
    document.getElementById('m-sub').textContent = [m.year, m.color].filter(Boolean).join(' · ');
    var st = document.getElementById('m-status');
    st.className = 'badge ' + m.status; st.textContent = statusLabel(m.status);
    var specs = [
      ['Ano', m.year], ['KM', fmtKm(m.km)], ['Cilindrada', m.cc ? m.cc + ' cc' : '—'],
      ['Cor', m.color || '—'], ['Combustível', m.fuel || '—'], ['Partida', m.start || '—']
    ];
    document.getElementById('m-specs').innerHTML = specs.map(function (s) {
      return '<div class="it"><small>' + s[0] + '</small><b>' + s[1] + '</b></div>';
    }).join('');
    document.getElementById('m-notes').textContent = m.notes || '';
    document.getElementById('m-price').textContent = fmt(m.salePrice);
    document.getElementById('m-wa').href = waLink('Olá! Tenho interesse na ' + m.brand + ' ' + m.model + ' ' + m.year + ' (' + fmt(m.salePrice) + ') anunciada no site da ' + C.brand + '.');
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
    document.getElementById('f-sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });
  });
})();
