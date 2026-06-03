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
  function introSlide(list) {
    var feats = list.map(function (m, i) { return { m: m, idx: i + 1 }; })
      .filter(function (x) { return x.m.highlight && x.m.photos.length; });
    if (!feats.length) feats = list.slice(0, 6).map(function (m, i) { return { m: m, idx: i + 1 }; });
    var cards = feats.map(function (x) {
      return '<div class="q-feat-card" onclick="QV.go(' + x.idx + ')">' +
        '<div class="q-feat-img" style="background-image:url(\'' + x.m.photos[0] + '\')"></div>' +
        '<div class="q-feat-b"><div class="q-feat-name">' + esc(x.m.brand + ' ' + x.m.model) + '</div>' +
        '<div class="q-feat-price">' + priceText(x.m) + '</div></div></div>';
    }).join('');
    return '<section class="q-slide q-intro" data-slide="0">' +
      '<div class="q-bg"></div>' +
      '<div class="in">' +
      '<div class="eyebrow">' + esc(C.tagline) + '</div>' +
      '<h1>As melhores motos<br>de <span>Betim</span>.</h1>' +
      '<p>Honda, Yamaha e mais — revisadas e com procedência. Financiamento facilitado e a sua usada na troca.</p>' +
      '<a class="q-cta-main" onclick="QV.go(1)"><i class="fas fa-arrow-down"></i> Ver o estoque</a>' +
      '</div>' +
      '<div class="q-feat">' +
      '<div class="q-feat-h"><i class="fas fa-star"></i> Destaques</div>' +
      '<div class="q-feat-row">' + cards + '</div>' +
      '</div></section>';
  }

  function vehSlide(m, slideIdx) {
    var ph = photosOf(m), has = ph.length > 0;
    var bg = has
      ? '<div class="q-bgwrap">' + ph.map(function (p, i) {
          return '<div class="q-ph-layer' + (i === 0 ? ' on' : '') + '" style="background-image:url(\'' + p + '\')"></div>';
        }).join('') + '</div>'
      : '<div class="q-bg q-ph"><i class="fas ' + typeIcon(m) + '"></i><div class="w">' + esc(m.brand + ' ' + m.model) + '</div></div>';
    var dots = ph.length > 1 ? '<div class="q-dots">' + ph.map(function (_, i) { return '<i class="' + (i === 0 ? 'on' : '') + '"></i>'; }).join('') + '</div>' : '';
    var nav = ph.length > 1 ? '<div class="q-tap l" onclick="event.stopPropagation();QV.photo(\'' + m.id + '\',-1)"></div><div class="q-tap r" onclick="event.stopPropagation();QV.photo(\'' + m.id + '\',1)"></div>' : '';
    var pills = [m.year, (m.km > 0 ? fmtKm(m.km) : ''), (m.cc ? m.cc + 'cc' : ''), m.color].filter(Boolean);
    return '<section class="q-slide veh" data-id="' + m.id + '" data-slide="' + slideIdx + '">' +
      bg + '<div class="q-grad"></div>' + nav + dots +
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
    var html = introSlide(list);
    list.forEach(function (m, i) { pidx[m.id] = 0; html += vehSlide(m, i + 1); });
    html += contactSlide(list.length + 1);
    feed.innerHTML = html;
    feed.scrollTo(0, 0);
    slidesEls = [].slice.call(feed.querySelectorAll('.q-slide'));
    attachSwipe();
    buildRail(slidesEls.length);
    observe();
  }

  /* Swipe horizontal confiável: ao detectar gesto pra o lado, TRAVA a rolagem
     vertical (preventDefault) — assim nunca pula de moto sem querer. */
  function attachSwipe() {
    slidesEls.forEach(function (s) {
      var id = s.dataset.id; if (!id) return;
      var x0 = 0, y0 = 0, horiz = false, active = false;
      s.addEventListener('touchstart', function (e) {
        var t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; horiz = false; active = true;
      }, { passive: true });
      s.addEventListener('touchmove', function (e) {
        if (!active) return;
        var t = e.touches[0], dx = t.clientX - x0, dy = t.clientY - y0;
        if (!horiz && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) horiz = true;
        if (horiz) e.preventDefault(); // segura a rolagem vertical durante o swipe lateral
      }, { passive: false });
      s.addEventListener('touchend', function (e) {
        if (!active) return; active = false;
        if (!horiz) return;
        var dx = e.changedTouches[0].clientX - x0;
        if (Math.abs(dx) > 35) photo(id, dx < 0 ? 1 : -1);
      }, { passive: false });
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
    if (state.gallery.length) { ph.className = 'ph'; ph.style.backgroundImage = "url('" + state.gallery[state.gIdx] + "')"; ph.innerHTML = ''; }
    else { ph.className = 'ph empty'; ph.style.backgroundImage = 'none'; ph.innerHTML = '<i class="fas ' + typeIcon(m) + '"></i>'; }
    var c = document.getElementById('d-count'); if (c) c.textContent = state.gallery.length > 1 ? (state.gIdx + 1) + '/' + state.gallery.length : '';
    var hint = document.querySelector('#d-gal .q-gal-hint'); if (hint) hint.style.display = state.gallery.length ? '' : 'none';
  }
  function closeDetail() { document.getElementById('detail').classList.remove('open'); document.body.style.overflow = ''; }

  /* ---------- Visualizador fullscreen: zoom (pinça/duplo-toque), swipe troca, arrasta pra baixo fecha ---------- */
  var lb = { ph: [], i: 0, scale: 1, tx: 0, ty: 0 };
  function lbApply() { document.getElementById('lb-img').style.transform = 'translate(' + lb.tx + 'px,' + lb.ty + 'px) scale(' + lb.scale + ')'; }
  function lbRender() {
    var img = document.getElementById('lb-img');
    img.src = lb.ph[lb.i] || ''; img.style.opacity = '1';
    lb.scale = 1; lb.tx = 0; lb.ty = 0; lbApply();
    document.getElementById('lb-dots').innerHTML = lb.ph.length > 1 ? lb.ph.map(function (_, k) { return '<i class="' + (k === lb.i ? 'on' : '') + '"></i>'; }).join('') : '';
  }
  function lbOpen() {
    if (!state.gallery.length) return;
    lb.ph = state.gallery; lb.i = state.gIdx; lbRender();
    document.getElementById('lightbox').classList.add('open');
  }
  function lbClose() {
    document.getElementById('lightbox').classList.remove('open');
    state.gIdx = lb.i;
    var ph = document.getElementById('d-ph'); if (state.gallery.length && ph) ph.style.backgroundImage = "url('" + state.gallery[lb.i] + "')";
    var c = document.getElementById('d-count'); if (c && state.gallery.length > 1) c.textContent = (lb.i + 1) + '/' + state.gallery.length;
  }
  function lbNav(dir) { if (lb.ph.length < 2) return; lb.i = (lb.i + dir + lb.ph.length) % lb.ph.length; lbRender(); }
  function lbInit() {
    var stage = document.getElementById('lb-stage'); if (!stage) return;
    var st = { mode: null, sx: 0, sy: 0, sd: 0, sscale: 1, stx: 0, sty: 0, lastTap: 0 };
    function d2(t) { var a = t[0], b = t[1]; return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
    stage.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) { st.mode = 'pinch'; st.sd = d2(e.touches); st.sscale = lb.scale; }
      else {
        var now = Date.now();
        if (now - st.lastTap < 300) { lb.scale = lb.scale > 1 ? 1 : 2.6; lb.tx = 0; lb.ty = 0; lbApply(); st.mode = null; st.lastTap = 0; e.preventDefault(); return; }
        st.lastTap = now; st.mode = 'pan'; st.sx = e.touches[0].clientX; st.sy = e.touches[0].clientY; st.stx = lb.tx; st.sty = lb.ty;
      }
    }, { passive: false });
    stage.addEventListener('touchmove', function (e) {
      e.preventDefault();
      if (st.mode === 'pinch' && e.touches.length === 2) { lb.scale = Math.min(4, Math.max(1, st.sscale * d2(e.touches) / st.sd)); lbApply(); }
      else if (st.mode === 'pan') {
        var dx = e.touches[0].clientX - st.sx, dy = e.touches[0].clientY - st.sy, img = document.getElementById('lb-img');
        if (lb.scale > 1) { lb.tx = st.stx + dx; lb.ty = st.sty + dy; lbApply(); }
        else if (Math.abs(dy) > Math.abs(dx)) { img.style.transform = 'translate(0,' + dy + 'px) scale(1)'; img.style.opacity = String(Math.max(0.3, 1 - Math.abs(dy) / 420)); }
        else { img.style.transform = 'translate(' + (dx * 0.4) + 'px,0) scale(1)'; }
      }
    }, { passive: false });
    stage.addEventListener('touchend', function (e) {
      var img = document.getElementById('lb-img');
      if (st.mode === 'pan' && lb.scale <= 1) {
        var dx = e.changedTouches[0].clientX - st.sx, dy = e.changedTouches[0].clientY - st.sy;
        if (dy > 95 && dy > Math.abs(dx)) { lbClose(); st.mode = null; return; }
        if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) { lbNav(dx < 0 ? 1 : -1); st.mode = null; return; }
        img.style.opacity = '1'; lbApply();
      } else if (st.mode === 'pinch' && lb.scale < 1.05) { lb.scale = 1; lb.tx = 0; lb.ty = 0; lbApply(); }
      st.mode = null;
    }, { passive: false });
  }

  window.QV = { go: go, photo: photo, openDetail: openDetail, closeDetail: closeDetail, lbOpen: lbOpen, lbClose: lbClose };

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (document.getElementById('lightbox').classList.contains('open')) lbClose(); else closeDetail();
  });

  document.addEventListener('DOMContentLoaded', function () {
    applyBrand();
    buildFeed();
    lbInit();
  });
})();
