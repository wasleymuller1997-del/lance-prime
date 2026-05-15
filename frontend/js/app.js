let currentEvent = null;
let currentVehicles = [];
let currentVehicle = null;
let timerInterval = null;
let gridTimerInterval = null;
let ws = null;

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(protocol + '//' + window.location.host + '/ws');
  ws.onopen = function() { console.log('WebSocket conectado'); };
  ws.onmessage = function(event) {
    const msg = JSON.parse(event.data);
    if (msg.type === 'bid_update') handleBidUpdate(msg.advertisement_id, msg.data);
  };
  ws.onclose = function() { setTimeout(connectWebSocket, 3000); };
}

function handleBidUpdate(adId, data) {
  const idx = currentVehicles.findIndex(function(v) { return v.id === adId; });
  if (idx !== -1 && data) {
    if (data.value_actual) currentVehicles[idx].negotiation.value_actual = data.value_actual;
    if (data.offers) currentVehicles[idx].offers = data.offers;
    if (data.offer_actual) currentVehicles[idx].offer_actual = data.offer_actual;
    renderVehicles(currentVehicles);
    if (currentVehicle && currentVehicle.id === adId) {
      currentVehicle = currentVehicles[idx];
      renderVehicleDetail(currentVehicle);
    }
  }
}

connectWebSocket();

function navigateTo(page) {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.nav-link').forEach(function(l) { l.classList.remove('active'); });
  document.getElementById('page-' + page).classList.add('active');
  var navLink = document.querySelector('[data-page="' + page + '"]');
  if (navLink) navLink.classList.add('active');
  if (page === 'catalog') loadEvents();
  localStorage.setItem('lp_page', page);
  window.scrollTo(0, 0);
}

document.getElementById('mobile-toggle').addEventListener('click', function() {
  document.querySelector('.nav-links').classList.toggle('open');
});

document.querySelectorAll('.nav-link').forEach(function(link) {
  link.addEventListener('click', function(e) {
    e.preventDefault();
    document.querySelector('.nav-links').classList.remove('open');
    navigateTo(link.dataset.page);
  });
});

function formatCurrency(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function formatTimer(endDate) {
  var now = new Date();
  var end = new Date(endDate);
  var diff = end - now;
  if (diff <= 0) return { text: 'Encerrado', active: false };
  var days = Math.floor(diff / (1000 * 60 * 60 * 24));
  var hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  var minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  var seconds = Math.floor((diff % (1000 * 60)) / 1000);
  var text = '';
  if (days > 0) text += days + 'd ';
  text += String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  return { text: text, active: true };
}

function getVehicleImage(vehicle) {
  var gallery = vehicle.image_gallery;
  if (gallery && gallery.length > 0) {
    var url = gallery[0].image || gallery[0].thumb || '';
    if (url) return '/api/img?url=' + encodeURIComponent(url);
  }
  return '';
}

function getVehicleImages(vehicle) {
  var gallery = vehicle.image_gallery;
  if (gallery && gallery.length > 0) {
    return gallery.map(function(img) {
      var url = img.image || img.thumb || '';
      return url ? '/api/img?url=' + encodeURIComponent(url) : '';
    }).filter(function(u) { return u; });
  }
  return [];
}

async function loadEvents() {
  try {
    var res = await api.getEvents();
    if (res.success) {
      var select = document.getElementById('filter-event');
      select.innerHTML = '<option value="">Selecione um evento</option>';
      res.data.forEach(function(event) {
        var opt = document.createElement('option');
        opt.value = event.id;
        var name = event.name
          .replace(/dealers\s*club/gi, 'LancePrime')
          .replace(/dealers/gi, 'LancePrime')
          .replace(/venda\s*direta/gi, 'Venda Direta')
          .trim();
        opt.textContent = name;
        select.appendChild(opt);
      });
      document.getElementById('stat-events').textContent = res.data.length;
    }
  } catch (err) {
    console.error('Erro ao carregar eventos:', err);
  }
}

async function loadVehicles(eventId) {
  var grid = document.getElementById('vehicles-grid');
  grid.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i> Carregando...</div>';
  try {
    var res = await api.getEventVehicles(eventId);
    if (res.success && res.data.length > 0) {
      currentVehicles = res.data;
      document.getElementById('stat-vehicles').textContent = res.data.length;
      document.getElementById('catalog-count').textContent = res.data.length + ' veículos';
      renderVehicles(res.data);
      startGridTimers();
    } else {
      grid.innerHTML = '<div class="empty-state"><i class="fas fa-car-side"></i><h3>Nenhum veículo</h3><p>Nenhum veículo encontrado.</p></div>';
    }
  } catch (err) {
    grid.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><h3>Erro</h3><p>Não foi possível carregar.</p></div>';
  }
}

function renderVehicles(vehicles) {
  var grid = document.getElementById('vehicles-grid');
  var html = '';
  vehicles.forEach(function(v) {
    var vehicle = v.vehicle;
    var neg = v.negotiation;
    var price = v.offer_actual ? v.offer_actual.price : neg.value_actual;
    var minBid = price + neg.increment;
    var timer = formatTimer(neg.finish_date_offer);
    var badges = '';
    if (timer.active) badges += '<span class="badge badge-live"><i class="fas fa-circle"></i> AO VIVO</span>';
    if (v.offers > 0) badges += '<span class="badge badge-offers">' + v.offers + ' oferta' + (v.offers > 1 ? 's' : '') + '</span>';

    var images = getVehicleImages(vehicle);
    html += '<div class="vehicle-card">';
    html += '<div class="vehicle-card-img-wrap" data-card-id="' + v.id + '" onclick="openVehicle(' + v.id + ')">';
    if (images.length > 0) {
      html += '<img class="vehicle-card-img" src="' + images[0] + '" alt="' + (vehicle.brand_name || '') + '" loading="lazy" data-index="0" data-images=\'' + JSON.stringify(images) + '\'>';
      if (images.length > 1) {
        html += '<button class="carousel-btn prev" onclick="event.stopPropagation();cardCarousel(' + v.id + ',-1)"><i class="fas fa-chevron-left"></i></button>';
        html += '<button class="carousel-btn next" onclick="event.stopPropagation();cardCarousel(' + v.id + ',1)"><i class="fas fa-chevron-right"></i></button>';
        html += '<div class="carousel-dots">';
        for (var di = 0; di < Math.min(images.length, 8); di++) {
          html += '<span class="carousel-dot' + (di === 0 ? ' active' : '') + '"></span>';
        }
        html += '</div>';
      }
    } else {
      html += '<div class="vehicle-card-img" style="background:var(--bg-card-hover);height:100%;display:flex;align-items:center;justify-content:center"><i class="fas fa-car" style="font-size:2rem;color:var(--text-dim)"></i></div>';
    }
    html += '<div class="vehicle-card-badges">' + badges + '</div>';
    html += '</div>';
    html += '<div class="vehicle-card-body" onclick="openVehicle(' + v.id + ')">';
    html += '<div class="vehicle-card-title">' + (vehicle.brand_name || '') + ' ' + (vehicle.model_name || '') + '</div>';
    html += '<div class="vehicle-card-subtitle">' + (vehicle.version_name || '') + '</div>';
    html += '<div class="vehicle-card-specs">';
    html += '<span class="spec-tag"><i class="fas fa-calendar"></i> ' + (vehicle.manufacture_year || '') + '/' + (vehicle.model_year || '') + '</span>';
    html += '<span class="spec-tag"><i class="fas fa-road"></i> ' + (vehicle.km ? vehicle.km.toLocaleString() + ' km' : 'N/I') + '</span>';
    html += '<span class="spec-tag"><i class="fas fa-palette"></i> ' + (vehicle.color_name || '') + '</span>';
    html += '</div>';
    html += '<div class="vehicle-card-footer">';
    html += '<div class="price-block"><div class="price-label">Preço atual</div><div class="price-value">' + formatCurrency(price) + '</div></div>';
    html += '<div class="timer-block"><div class="timer-label">Encerra em</div>';
    html += '<span class="timer-badge ' + (timer.active ? 'active' : '') + '" data-end="' + neg.finish_date_offer + '"><i class="fas fa-clock"></i> <span class="timer-text">' + timer.text + '</span></span>';
    html += '</div></div>';
    html += '<div class="fipe-badge-wrap" id="fipe-card-' + v.id + '"></div>';
    html += '</div>';
    html += '<div class="vehicle-card-bid">';
    html += '<div class="card-bid-row">';
    html += '<input type="number" class="card-bid-input" id="card-bid-' + v.id + '" value="' + minBid + '" min="' + minBid + '" step="' + neg.increment + '" onclick="event.stopPropagation()">';
    html += '<button class="card-bid-btn" onclick="event.stopPropagation();cardBid(' + v.id + ')"><i class="fas fa-gavel"></i> Ofertar</button>';
    html += '</div>';
    html += '</div>';
    html += '</div>';
  });
  grid.innerHTML = html;
  loadFipeBadges(vehicles);
}

function startGridTimers() {
  if (gridTimerInterval) clearInterval(gridTimerInterval);
  gridTimerInterval = setInterval(function() {
    document.querySelectorAll('.timer-badge[data-end]').forEach(function(badge) {
      var end = badge.getAttribute('data-end');
      var timer = formatTimer(end);
      var textEl = badge.querySelector('.timer-text');
      if (textEl) textEl.textContent = timer.text;
      badge.className = 'timer-badge ' + (timer.active ? 'active' : '');
    });
  }, 1000);
}

function loadFipeBadges(vehicles) {
  vehicles.forEach(function(v) {
    var vehicle = v.vehicle;
    var neg = v.negotiation;
    var price = v.offer_actual ? v.offer_actual.price : neg.value_actual;
    api.getFipeValue(vehicle.brand_name, vehicle.model_name, vehicle.version_name, vehicle.model_year).then(function(res) {
      var el = document.getElementById('fipe-card-' + v.id);
      if (!el) return;
      if (res.success && res.data) {
        var fipe = res.data.value;
        var pct = ((fipe - price) / fipe * 100).toFixed(0);
        if (pct > 0) {
          el.innerHTML = '<span class="fipe-badge fipe-good"><i class="fas fa-arrow-down"></i> ' + pct + '% abaixo FIPE</span>';
        } else {
          el.innerHTML = '<span class="fipe-badge fipe-bad"><i class="fas fa-arrow-up"></i> ' + Math.abs(pct) + '% acima FIPE</span>';
        }
      } else {
        el.innerHTML = '<span class="fipe-badge fipe-na">FIPE indisponível</span>';
      }
    });
  });
}

function loadFipeDetail(v) {
  var vehicle = v.vehicle;
  var neg = v.negotiation;
  var price = v.offer_actual ? v.offer_actual.price : neg.value_actual;
  api.getFipeValue(vehicle.brand_name, vehicle.model_name, vehicle.version_name, vehicle.model_year).then(function(res) {
    var el = document.getElementById('fipe-detail');
    if (!el) return;
    if (res.success && res.data) {
      var fipe = res.data.value;
      var pct = ((fipe - price) / fipe * 100).toFixed(1);
      var economia = fipe - price;
      var html = '<div class="fipe-detail-card">';
      html += '<div class="fipe-detail-title"><i class="fas fa-chart-line"></i> Análise FIPE</div>';
      html += '<div class="fipe-detail-row"><span>Valor FIPE (' + res.data.reference + ')</span><span class="fipe-value">' + formatCurrency(fipe) + '</span></div>';
      html += '<div class="fipe-detail-row"><span>Preço atual</span><span>' + formatCurrency(price) + '</span></div>';
      if (pct > 0) {
        html += '<div class="fipe-detail-row highlight"><span>Economia</span><span class="fipe-good-text"><i class="fas fa-arrow-down"></i> ' + pct + '% abaixo (' + formatCurrency(economia) + ')</span></div>';
      } else {
        html += '<div class="fipe-detail-row highlight"><span>Diferença</span><span class="fipe-bad-text"><i class="fas fa-arrow-up"></i> ' + Math.abs(pct) + '% acima</span></div>';
      }
      html += '</div>';
      el.innerHTML = html;
    } else {
      el.innerHTML = '<div class="fipe-detail-card"><div class="fipe-detail-title"><i class="fas fa-chart-line"></i> FIPE indisponível</div></div>';
    }
  });
}

function cardCarousel(cardId, direction) {
  var wrap = document.querySelector('[data-card-id="' + cardId + '"]');
  if (!wrap) return;
  var img = wrap.querySelector('.vehicle-card-img');
  var images = JSON.parse(img.getAttribute('data-images'));
  var idx = parseInt(img.getAttribute('data-index')) + direction;
  if (idx < 0) idx = images.length - 1;
  if (idx >= images.length) idx = 0;
  img.src = images[idx];
  img.setAttribute('data-index', idx);
  var dots = wrap.querySelectorAll('.carousel-dot');
  dots.forEach(function(d, i) { d.classList.toggle('active', i === idx); });
}

function openVehicle(id) {
  currentVehicle = currentVehicles.find(function(v) { return v.id === id; });
  if (!currentVehicle) return;
  localStorage.setItem('lp_vehicle', id);
  navigateTo('vehicle');
  renderVehicleDetail(currentVehicle);
  startTimer();
}

function renderVehicleDetail(v) {
  var vehicle = v.vehicle;
  var neg = v.negotiation;
  var price = v.offer_actual ? v.offer_actual.price : neg.value_actual;
  var minBid = price + neg.increment;
  var images = getVehicleImages(vehicle);
  var mainImg = images.length > 0 ? images[0] : '';

  var thumbsHtml = '';
  images.slice(0, 10).forEach(function(url, i) {
    thumbsHtml += '<img src="' + url + '" onclick="changeImage(\'' + url + '\')" class="' + (i === 0 ? 'active' : '') + '" loading="lazy">';
  });

  var html = '<div class="vehicle-gallery" style="position:relative">';
  html += '<img id="main-image" src="' + mainImg + '" alt="' + (vehicle.brand_name || '') + '" data-index="0" onclick="openLightbox()">';
  if (images.length > 1) {
    html += '<button class="carousel-btn prev" onclick="galleryNav(-1)"><i class="fas fa-chevron-left"></i></button>';
    html += '<button class="carousel-btn next" onclick="galleryNav(1)"><i class="fas fa-chevron-right"></i></button>';
  }
  html += '<div class="vehicle-thumbnails">' + thumbsHtml + '</div></div>';
  html += '<div class="vehicle-sidebar">';
  html += '<h2>' + (vehicle.brand_name || '') + ' ' + (vehicle.model_name || '') + '</h2>';
  html += '<div class="subtitle">' + (vehicle.version_name || '') + ' — ' + vehicle.manufacture_year + '/' + vehicle.model_year + '</div>';
  html += '<div class="bid-section">';
  html += '<div class="bid-row"><span class="label">Preço Atual</span><span class="value highlight">' + formatCurrency(price) + '</span></div>';
  html += '<div class="bid-row"><span class="label">Ofertas</span><span class="value">' + v.offers + '</span></div>';
  html += '<div class="bid-row"><span class="label">Incremento mínimo</span><span class="value">' + formatCurrency(neg.increment) + '</span></div>';
  html += '</div>';
  html += '<div class="fipe-detail-wrap" id="fipe-detail"></div>';
  html += '<div class="bid-timer"><div class="bid-timer-label"><i class="fas fa-clock"></i> Tempo Restante</div>';
  html += '<div class="bid-timer-value" id="detail-timer">--:--:--</div></div>';
  html += '<div class="bid-input-group">';
  html += '<input type="number" class="bid-input" id="bid-value" placeholder="Sua oferta" value="' + minBid + '" min="' + minBid + '" step="' + neg.increment + '">';
  html += '<button class="btn-increment" onclick="incrementBid(' + neg.increment + ')">+' + neg.increment + '</button></div>';
  html += '<button class="btn-bid" onclick="submitBid(' + v.id + ')"><i class="fas fa-gavel"></i> Enviar Oferta</button>';
  if (neg.immediate_sale_price) {
    html += '<button class="btn-buynow" onclick="submitBuyNow(' + v.id + ', ' + neg.immediate_sale_price + ')"><i class="fas fa-bolt"></i> Comprar Agora por ' + formatCurrency(neg.immediate_sale_price) + '</button>';
  }
  html += '<div class="vehicle-specs">';
  html += '<div class="spec-row"><span class="label">Categoria</span><span>' + (vehicle.category_name || '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">Cor</span><span>' + (vehicle.color_name || '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">Câmbio</span><span>' + (vehicle.drive_shift_name || '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">Combustível</span><span>' + (vehicle.fuel_name || '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">KM</span><span>' + (vehicle.km ? vehicle.km.toLocaleString() : '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">Vendedor</span><span>' + (v.shop.name || '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">Local</span><span>' + (v.shop.city || '') + '/' + (v.shop.state || '') + '</span></div>';
  html += '</div></div>';

  document.getElementById('vehicle-detail').innerHTML = html;
  loadFipeDetail(v);
}

function changeImage(url) {
  document.getElementById('main-image').src = url;
  document.querySelectorAll('.vehicle-thumbnails img').forEach(function(img) {
    img.classList.toggle('active', img.src === url);
  });
}

function galleryNav(direction) {
  if (!currentVehicle) return;
  var images = getVehicleImages(currentVehicle.vehicle);
  var mainImg = document.getElementById('main-image');
  var idx = parseInt(mainImg.getAttribute('data-index')) + direction;
  if (idx < 0) idx = images.length - 1;
  if (idx >= images.length) idx = 0;
  mainImg.src = images[idx];
  mainImg.setAttribute('data-index', idx);
  document.querySelectorAll('.vehicle-thumbnails img').forEach(function(img, i) {
    img.classList.toggle('active', i === idx);
  });
}

var lightboxIndex = 0;
var lightboxImages = [];

function openLightbox() {
  if (!currentVehicle) return;
  lightboxImages = getVehicleImages(currentVehicle.vehicle);
  var mainImg = document.getElementById('main-image');
  lightboxIndex = parseInt(mainImg.getAttribute('data-index')) || 0;
  var overlay = document.getElementById('lightbox');
  document.getElementById('lightbox-img').src = lightboxImages[lightboxIndex];
  document.getElementById('lightbox-counter').textContent = (lightboxIndex + 1) + ' / ' + lightboxImages.length;
  overlay.classList.add('active');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('active');
}

function lightboxNav(direction) {
  lightboxIndex += direction;
  if (lightboxIndex < 0) lightboxIndex = lightboxImages.length - 1;
  if (lightboxIndex >= lightboxImages.length) lightboxIndex = 0;
  document.getElementById('lightbox-img').src = lightboxImages[lightboxIndex];
  document.getElementById('lightbox-counter').textContent = (lightboxIndex + 1) + ' / ' + lightboxImages.length;
}

document.addEventListener('keydown', function(e) {
  var overlay = document.getElementById('lightbox');
  if (!overlay.classList.contains('active')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') lightboxNav(-1);
  if (e.key === 'ArrowRight') lightboxNav(1);
});

function incrementBid(increment) {
  var input = document.getElementById('bid-value');
  input.value = parseInt(input.value) + increment;
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(function() {
    if (!currentVehicle) return;
    var timer = formatTimer(currentVehicle.negotiation.finish_date_offer);
    var el = document.getElementById('detail-timer');
    if (el) el.textContent = timer.text;
  }, 1000);
}

async function cardBid(advertisementId) {
  var input = document.getElementById('card-bid-' + advertisementId);
  var value = parseInt(input.value);
  if (!value) return alert('Informe o valor da oferta');
  if (!confirm('Confirma oferta de ' + formatCurrency(value) + '?')) return;
  try {
    var res = await api.placeBid(advertisementId, value);
    if (res.success) {
      alert('Oferta enviada com sucesso!');
      var savedEvent = localStorage.getItem('lp_event');
      if (savedEvent) loadVehicles(savedEvent);
    } else {
      alert('Erro: ' + (res.error || 'Não foi possível enviar a oferta'));
    }
  } catch (err) {
    alert('Erro ao enviar oferta: ' + err.message);
  }
}

async function submitBid(advertisementId) {
  var value = parseInt(document.getElementById('bid-value').value);
  if (!value) return alert('Informe o valor da oferta');
  if (!confirm('Confirma oferta de ' + formatCurrency(value) + '?')) return;
  try {
    var res = await api.placeBid(advertisementId, value);
    if (res.success) {
      alert('Oferta enviada com sucesso!');
    } else {
      alert('Erro: ' + (res.error || 'Não foi possível enviar a oferta'));
    }
  } catch (err) {
    alert('Erro ao enviar oferta: ' + err.message);
  }
}

async function submitBuyNow(advertisementId, value) {
  if (!confirm('Confirma compra imediata por ' + formatCurrency(value) + '?')) return;
  try {
    var res = await api.buyNow(advertisementId, value);
    if (res.success) {
      alert('Compra realizada com sucesso!');
    } else {
      alert('Erro: ' + (res.error || 'Não foi possível realizar a compra'));
    }
  } catch (err) {
    alert('Erro: ' + err.message);
  }
}

document.getElementById('filter-sort').addEventListener('change', function(e) {
  if (!currentVehicles.length) return;
  var sorted = currentVehicles.slice();
  switch (e.target.value) {
    case 'price-asc':
      sorted.sort(function(a, b) { return a.negotiation.value_actual - b.negotiation.value_actual; });
      break;
    case 'price-desc':
      sorted.sort(function(a, b) { return b.negotiation.value_actual - a.negotiation.value_actual; });
      break;
    case 'time':
      sorted.sort(function(a, b) { return new Date(a.negotiation.finish_date_offer) - new Date(b.negotiation.finish_date_offer); });
      break;
  }
  renderVehicles(sorted);
});

document.getElementById('filter-event').addEventListener('change', function(e) {
  if (e.target.value) {
    localStorage.setItem('lp_event', e.target.value);
    loadVehicles(e.target.value);
  }
});

(async function restoreState() {
  var savedPage = localStorage.getItem('lp_page');
  var savedEvent = localStorage.getItem('lp_event');
  var savedVehicle = localStorage.getItem('lp_vehicle');

  if (savedPage === 'catalog' || savedPage === 'vehicle') {
    document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
    document.getElementById('page-catalog').classList.add('active');
    document.querySelectorAll('.nav-link').forEach(function(l) { l.classList.remove('active'); });
    var navLink = document.querySelector('[data-page="catalog"]');
    if (navLink) navLink.classList.add('active');
    await loadEvents();
    if (savedEvent) {
      var select = document.getElementById('filter-event');
      if (select) select.value = savedEvent;
      await loadVehicles(savedEvent);
      if (savedPage === 'vehicle' && savedVehicle) {
        openVehicle(parseInt(savedVehicle));
      }
    }
  } else if (savedPage && savedPage !== 'home') {
    navigateTo(savedPage);
  } else {
    loadEvents();
  }
})();
