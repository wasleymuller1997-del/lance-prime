/* =====================================================================
 * QAVAH — Vitrine pública (showcase)
 * Feed vertical com snap: um veículo por vez, tela cheia, mobile-first.
 * Lê do MotoStore (somente leitura). Preço "Sob consulta" + WhatsApp.
 * ===================================================================== */
(function () {
  var C = window.MP_CONFIG, fmt = window.MP.fmt, fmtKm = window.MP.fmtKm, Store = window.MotoStore;
  var state = { filter: '', gallery: [], gIdx: 0 };
  var pidx = {}; // índice da foto atual por veículo

  function esc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function statusLabel(s) { return s === 'reservada' ? 'Reservada' : s === 'vendida' ? 'Vendida' : 'Disponível'; }
  function priceText(m) { return Number(m.salePrice) > 0 ? fmt(m.salePrice) : 'Sob consulta'; }
  function typeIcon(m) { return (m.type === 'Carro') ? 'fa-car-side' : 'fa-motorcycle'; }
  function photosOf(m) { return (m.photos && m.photos.length) ? m.photos : []; }
  function waLink(t) { return 'https://wa.me/' + C.whatsapp + '?text=' + encodeURIComponent(t); }
  function waItem(m) {
    var p = Number(m.salePrice) > 0 ? ' (' + fmt(m.salePrice) + ')' : '';
    return waLink('Olá, QAVAH! Tenho interesse no ' + m.brand + ' ' + m.model + ' ' + (m.year || '') + p + ' que vi no site.');
  }
  function waGeneral() { return waLink('Olá, QAVAH! Vi o site e quero saber mais sobre os veículos.'); }

  /* ---------- Marca / cores ---------- */
  function applyBrand() {
    var r = document.documentElement.style;
    r.setProperty('--primary', C.colors.primary); r.setProperty('--accent', C.colors.accent);
    r.setProperty('--bg', C.colors.bg); r.setProperty('--card', C.colors.card);
    document.title = C.brand + ' ' + (C.brandSuffix || '') + ' — Motos';
    var brand = document.getElementById('q-brand');
    brand.innerHTML = C.logo
      ? '<img class="logo-img" src="' + C.logo + '" alt="' + esc(C.brand) + '">'
      : '<span class="emblem"><i class="fas fa-motorcycle"></i></span>' +
        '<span class="wm"><b>' + esc(C.brand) + '</b><i>' + esc(C.brandSuffix || '') + '</i></span>';
    document.getElementById('q-wa-top').href = waGeneral();
  }

  /* ---------- Slides ---------- */
  function introSlide(total) {
    return '<section class="q-slide q-intro" data-slide="0">' +
      '<div class="q-bg"></div><div class="in">' +
      '<div class="eyebrow">' + esc(C.tagline) + '</div>' +
      '<h1>Motos <span>revisadas</span><br>e prontas pra rodar.</h1>' +
      '<p>Estoque selecionado em ' + esc(C.city) + '. Financiamento facilitado e aceitamos a sua usada na troca.</p>' +
      '<a class="q-cta-main" onclick="QV.go(1)"><i class="fas fa-arrow-down"></i> Ver o estoque</a>' +
      '<div class="stats">' +
      '<div><div class="n q-count" data-to="' + total + '">0</div><small>motos</small></div>' +
      '<div><div class="n q-count" data-to="60" data-suffix="x">0</div><small>financiamento</small></div>' +
      '<div><div class="n">Troca</div><small>sua usada</small></div>' +
      '</div></div>' +
      '<div class="q-hint"><i class="fas fa-chevron-down"></i> deslize para começar</div></section>';
  }

  function vehSlide(m, slideIdx) {
    var ph = photosOf(m), has = ph.length > 0;
    var bg = has
      ? '<div class="q-bgwrap" onclick="QV.openDetail(\'' + m.id + '\')">' + ph.map(function (p, i) {
          return '<div class="q-ph-layer' + (i === 0 ? ' on' : '') + '" style="background-image:url(\'' + p + '\')"></div>';
        }).join('') + '</div>'
      : '<div class="q-bg q-ph"><i class="fas ' + typeIcon(m) + '"></i><div class="w">' + esc(m.brand + ' ' + m.model) + '</div></div>';
    var pbadge = ph.length ? '<button class="q-photos-btn" onclick="event.stopPropagation();QV.openDetail(\'' + m.id + '\')"><i class="fas fa-expand"></i> ' + ph.length + ' foto' + (ph.length > 1 ? 's' : '') + '</button>' : '';
    var pills = [m.year, (m.km > 0 ? fmtKm(m.km) : ''), (m.cc ? m.cc + 'cc' : ''), m.color].filter(Boolean);
    return '<section class="q-slide veh" data-id="' + m.id + '" data-slide="' + slideIdx + '">' +
      bg + '<div class="q-grad"></div>' + pbadge +
      '<div class="q-info">' +
      '<div class="q-type"><span class="q-st ' + m.status + '">' + statusLabel(m.status) + '</span></div>' +
      '<h2 class="q-name">' + esc(m.brand + ' ' + m.model) + '</h2>' +
      '<div class="q-pills">' + pills.map(function (s) { return '<span>' + esc(s) + '</span>'; }).join('') + '</div>' +
      (m.notes ? '<p class="q-desc">' + esc(m.notes) + '</p>' : '') +
      '<div class="q-priceRow"><div><small>Preço</small><div class="q-price">' + priceText(m) + '</div></div>' +
      '<a class="q-wa" target="_blank" href="' + waItem(m) + '"><i class="fab fa-whatsapp"></i> Tenho interesse</a></div>' +
      '<button class="q-more" onclick="QV.openDetail(\'' + m.id + '\')"><i class="fas fa-circle-info"></i> Ver ficha completa</button>' +
      '</div></section>';
  }

  function contactSlide(slideIdx) {
    return '<section class="q-slide q-contact" data-slide="' + slideIdx + '"><div class="q-bg"></div><div class="in">' +
      '<h2>Bora fechar negócio?</h2>' +
      '<p style="color:rgba(255,255,255,.7);max-width:34ch;margin:6px auto 0">Chama a ' + esc(C.brand) + ' no WhatsApp e tire suas dúvidas sem compromisso.</p>' +
      '<div class="lines">' +
      '<div><i class="fab fa-whatsapp"></i> ' + esc(C.phone) + '</div>' +
      '<div><i class="fas fa-envelope"></i> ' + esc(C.email) + '</div>' +
      '<div><i class="fas fa-location-dot"></i> ' + esc(C.city) + '</div>' +
      (C.instagram ? '<div><i class="fab fa-instagram"></i> ' + esc(C.instagram) + '</div>' : '') +
      '</div>' +
      '<a class="q-wa" target="_blank" href="' + waGeneral() + '" style="flex:none;display:inline-flex"><i class="fab fa-whatsapp"></i> Chamar no WhatsApp</a>' +
      '</div></section>';
  }

  function vehicles() {
    var list = Store.catalog().filter(function (m) { return m.status !== 'vendida'; });
    if (state.filter) list = list.filter(function (m) { return (m.type || 'Moto') === state.filter; });
    list.sort(function (a, b) { return (b.highlight ? 1 : 0) - (a.highlight ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0); });
    return list;
  }

  var slidesEls = [];
  function buildFeed() {
    var list = vehicles(), feed = document.getElementById('feed');
    var html = introSlide(Store.catalog().filter(function (m) { return m.status !== 'vendida'; }).length);
    list.forEach(function (m, i) { pidx[m.id] = 0; html += vehSlide(m, i + 1); });
    html += contactSlide(list.length + 1);
    feed.innerHTML = html;
    feed.scrollTo(0, 0);
    slidesEls = [].slice.call(feed.querySelectorAll('.q-slide'));
    /* swipe da vitrine removido: agora toque abre o box */
    buildRail(slidesEls.length);
    observe();
  }

  /* Swipe horizontal com o dedo troca a foto (sem atrapalhar o scroll vertical). */
  function attachSwipe() {
    slidesEls.forEach(function (s) {
      var id = s.dataset.id; if (!id) return;
      var x0 = 0, y0 = 0;
      s.addEventListener('touchstart', function (e) { var t = e.changedTouches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
      s.addEventListener('touchend', function (e) {
        var t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
        if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) photo(id, dx < 0 ? 1 : -1);
      }, { passive: true });
    });
  }

  /* ---------- Trilha lateral ---------- */
  function buildRail(n) {
    var rail = document.getElementById('q-rail');
    var h = ''; for (var i = 0; i < n; i++) h += '<b data-go="' + i + '"></b>';
    rail.innerHTML = h;
    rail.querySelectorAll('b').forEach(function (b) { b.onclick = function () { QV.go(+b.dataset.go); }; });
    setActive(0);
  }
  function setActive(i) {
    var rail = document.getElementById('q-rail');
    rail.querySelectorAll('b').forEach(function (b, k) { b.classList.toggle('on', k === i); });
  }

  var io;
  function observe() {
    if (io) io.disconnect();
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting && e.intersectionRatio > 0.55) {
          var idx = +e.target.dataset.slide; setActive(idx);
          slidesEls.forEach(function (s) { s.classList.toggle('is-active', s === e.target); });
          document.body.classList.toggle('q-scrolled', idx > 0); // header só no topo
          runCounts(e.target);
        }
      });
    }, { root: document.getElementById('feed'), threshold: [0.55] });
    slidesEls.forEach(function (s) { io.observe(s); });
  }

  /* números contando ao ativar (estilo Vorexi) */
  function runCounts(el) {
    el.querySelectorAll('.q-count').forEach(function (c) {
      if (c.dataset.done) return; c.dataset.done = '1';
      var to = +c.dataset.to || 0, suf = c.dataset.suffix || '', t0 = performance.now(), dur = 900;
      (function step(t) {
        var p = Math.min((t - t0) / dur, 1), v = Math.round(to * (0.5 - Math.cos(p * Math.PI) / 2));
        c.textContent = v + suf; if (p < 1) requestAnimationFrame(step);
      })(t0);
    });
  }

  function go(i) {
    if (slidesEls[i]) slidesEls[i].scrollIntoView({ behavior: 'smooth' });
  }

  /* ---------- Foto dentro do slide ---------- */
  function photo(id, dir) {
    var m = Store.catalogGet(id); if (!m) return;
    var ph = photosOf(m); if (ph.length < 2) return;
    pidx[id] = (pidx[id] + dir + ph.length) % ph.length;
    var slide = document.querySelector('.q-slide[data-id="' + id + '"]'); if (!slide) return;
    slide.querySelectorAll('.q-ph-layer').forEach(function (l, k) { l.classList.toggle('on', k === pidx[id]); });
    slide.querySelectorAll('.q-dots i').forEach(function (d, k) { d.classList.toggle('on', k === pidx[id]); });
  }

  /* ---------- Detalhe ---------- */
  function openDetail(id) {
    var m = Store.catalogGet(id); if (!m) return;
    state.gallery = photosOf(m); state.gIdx = 0;
    paintGallery(m);
    document.getElementById('d-title').textContent = m.brand + ' ' + m.model;
    document.getElementById('d-sub').textContent = [m.type, m.year, m.color].filter(Boolean).join(' · ');
    var specs = [['Tipo', m.type || '—'], ['Ano', m.year || '—'], ['KM', m.km > 0 ? fmtKm(m.km) : '—']];
    if (m.cc) specs.push(['Cilindrada', m.cc + ' cc']);
    specs.push(['Combustível', m.fuel || '—']);
    if (m.start) specs.push(['Partida', m.start]);
    specs.push(['Cor', m.color || '—']);
    document.getElementById('d-specs').innerHTML = specs.map(function (s) { return '<div class="it"><small>' + esc(s[0]) + '</small><b>' + esc(s[1]) + '</b></div>'; }).join('');
    document.getElementById('d-full').textContent = m.notes || '';
    document.getElementById('d-price').textContent = priceText(m);
    document.getElementById('d-wa').href = waItem(m);
    document.getElementById('detail').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function paintGallery(m) {
    var ph = document.getElementById('d-ph');
    if (state.gallery.length) { ph.className = 'ph'; ph.style.backgroundImage = "url('" + state.gallery[state.gIdx] + "')"; }
    else { ph.className = 'ph empty'; ph.style.backgroundImage = 'none'; ph.innerHTML = '<i class="fas ' + typeIcon(m) + '"></i>'; }
    document.querySelectorAll('#d-gal .arw').forEach(function (a) { a.style.display = state.gallery.length > 1 ? 'grid' : 'none'; });
  }
  function galNav(dir) {
    if (state.gallery.length < 2) return;
    state.gIdx = (state.gIdx + dir + state.gallery.length) % state.gallery.length;
    document.getElementById('d-ph').style.backgroundImage = "url('" + state.gallery[state.gIdx] + "')";
  }
  function closeDetail() { document.getElementById('detail').classList.remove('open'); document.body.style.overflow = ''; }

  window.QV = { go: go, photo: photo, openDetail: openDetail, closeDetail: closeDetail, galNav: galNav };

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });

  document.addEventListener('DOMContentLoaded', function () {
    applyBrand();
    buildFeed();
    // swipe pra trocar foto dentro do box
    var gal = document.getElementById('d-gal'), gx = 0, gy = 0;
    if (gal) {
      gal.addEventListener('touchstart', function (e) { var t = e.changedTouches[0]; gx = t.clientX; gy = t.clientY; }, { passive: true });
      gal.addEventListener('touchend', function (e) {
        var t = e.changedTouches[0], dx = t.clientX - gx, dy = t.clientY - gy;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) galNav(dx < 0 ? 1 : -1);
      }, { passive: true });
    }
  });
})();
