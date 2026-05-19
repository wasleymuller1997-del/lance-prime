let currentEvent = null;
let currentVehicles = [];
let currentVehicle = null;
let timerInterval = null;
let gridTimerInterval = null;
let ws = null;
let pollingInterval = null;

// === CONFIRM MODAL ===
var confirmResolveFn = null;
function showConfirm(title, message, details) {
  return new Promise(function(resolve) {
    confirmResolveFn = resolve;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    document.getElementById('confirm-details').innerHTML = details || '';
    document.getElementById('modal-confirm').style.display = 'flex';
    document.getElementById('confirm-btn-ok').onclick = function() {
      document.getElementById('modal-confirm').style.display = 'none';
      confirmResolveFn = null;
      resolve(true);
    };
  });
}
function confirmReject() {
  document.getElementById('modal-confirm').style.display = 'none';
  if (confirmResolveFn) confirmResolveFn(false);
  confirmResolveFn = null;
}

// === TOAST SYSTEM ===
function showToast(message, type, duration) {
  type = type || 'info';
  duration = duration || 4000;
  var container = document.getElementById('toast-container');
  var toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  var icon = type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : type === 'warning' ? 'fa-exclamation-triangle' : 'fa-info-circle';
  toast.innerHTML = '<i class="fas ' + icon + '"></i><span>' + message + '</span>';
  container.appendChild(toast);
  setTimeout(function() { toast.classList.add('show'); }, 10);
  setTimeout(function() {
    toast.classList.remove('show');
    setTimeout(function() { toast.remove(); }, 300);
  }, duration);
}

// === SOUND SYSTEM ===
var audioCtx = null;
function playSound(type) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    gain.gain.value = 0.3;
    if (type === 'bid') {
      osc.frequency.value = 800;
      osc.type = 'sine';
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
      osc.start(); osc.stop(audioCtx.currentTime + 0.3);
    } else if (type === 'urgent') {
      osc.frequency.value = 1000;
      osc.type = 'square';
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
      osc.start(); osc.stop(audioCtx.currentTime + 0.5);
    } else if (type === 'success') {
      osc.frequency.value = 600;
      osc.type = 'sine';
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
      osc.start(); osc.stop(audioCtx.currentTime + 0.2);
      setTimeout(function() {
        var osc2 = audioCtx.createOscillator();
        var gain2 = audioCtx.createGain();
        osc2.connect(gain2); gain2.connect(audioCtx.destination);
        gain2.gain.value = 0.3;
        osc2.frequency.value = 900;
        osc2.type = 'sine';
        gain2.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
        osc2.start(); osc2.stop(audioCtx.currentTime + 0.3);
      }, 150);
    }
  } catch(e) {}
}

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
    var vehicle = currentVehicles[idx];
    var oldPrice = vehicle.offer_actual ? vehicle.offer_actual.price : vehicle.negotiation.value_actual;
    if (data.value_actual) currentVehicles[idx].negotiation.value_actual = data.value_actual;
    if (data.offers) currentVehicles[idx].offers = data.offers;
    if (data.offer_actual) currentVehicles[idx].offer_actual = data.offer_actual;
    // Atualizar timer quando o tempo muda (lance estende o tempo)
    if (data.finish_date_offer) currentVehicles[idx].negotiation.finish_date_offer = data.finish_date_offer;
    if (data.finish_date) currentVehicles[idx].negotiation.finish_date_offer = data.finish_date;
    if (data.negotiation && data.negotiation.finish_date_offer) currentVehicles[idx].negotiation.finish_date_offer = data.negotiation.finish_date_offer;
    var newPrice = data.value_actual || (data.offer_actual ? data.offer_actual.price : oldPrice);
    if (newPrice > oldPrice) {
      var name = vehicle.vehicle.brand_name + ' ' + vehicle.vehicle.model_name;
      showToast('Lance coberto! ' + name + ' → ' + formatCurrency(newPrice), 'warning', 6000);
      playSound('bid');
    }
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
  if (page === 'dashboard') loadDashboard();
  if (page === 'home') {
    history.pushState(null, '', '/');
  } else if (page !== 'vehicle') {
    history.pushState(null, '', '#' + page);
  }
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

function formatBidValue(value) {
  return new Intl.NumberFormat('pt-BR').format(parseInt(value) || 0);
}

function maskBidInput(el) {
  var raw = el.value.replace(/\D/g, '');
  el.value = raw ? new Intl.NumberFormat('pt-BR').format(parseInt(raw)) : '';
}

function parseBidValue(str) {
  return parseInt(String(str).replace(/\D/g, '')) || 0;
}

// Time offset to sync with Dealers Club timer (ms)
var serverTimeOffset = 0;

// Sincronizar relógio com servidor
async function syncServerTime() {
  try {
    var t1 = Date.now();
    var res = await fetch('/api/server-time');
    var data = await res.json();
    var t2 = Date.now();
    var latency = (t2 - t1) / 2;
    serverTimeOffset = data.time - t2 + latency;
    console.log('Time sync offset:', serverTimeOffset, 'ms');
  } catch(e) {}
}
syncServerTime();
setInterval(syncServerTime, 60000); // Re-sync a cada 60s

function formatTimer(endDate) {
  var now = new Date(Date.now() + serverTimeOffset);
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
  grid.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
  try {
    var res = await api.getEventVehicles(eventId);
    if (res.success && res.data.length > 0) {
      currentVehicles = res.data;
      document.getElementById('stat-vehicles').textContent = res.data.length;
      document.getElementById('catalog-count').textContent = res.data.length + ' veículos';
      populateFilters(res.data);
      renderVehicles(res.data);
      startGridTimers();
      startPolling(eventId);
    } else {
      grid.innerHTML = '<div class="empty-state"><i class="fas fa-car-side"></i><h3>Nenhum veículo</h3><p>Nenhum veículo encontrado.</p></div>';
      stopPolling();
    }
  } catch (err) {
    grid.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><h3>Erro</h3><p>Não foi possível carregar.</p></div>';
  }
}

function startPolling(eventId) {
  stopPolling();
  pollingInterval = setInterval(function() { pollVehicles(eventId); }, 3000);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

async function pollVehicles(eventId) {
  try {
    var res = await api.getEventVehicles(eventId);
    if (!res.success || !res.data || res.data.length === 0) return;
    var newVehicles = res.data;
    var changed = false;
    for (var i = 0; i < newVehicles.length; i++) {
      var nv = newVehicles[i];
      var idx = currentVehicles.findIndex(function(v) { return v.id === nv.id; });
      if (idx === -1) { changed = true; continue; }
      var old = currentVehicles[idx];
      var oldPrice = old.offer_actual ? old.offer_actual.price : old.negotiation.value_actual;
      var newPrice = nv.offer_actual ? nv.offer_actual.price : nv.negotiation.value_actual;
      if (newPrice !== oldPrice || nv.negotiation.finish_date_offer !== old.negotiation.finish_date_offer) {
        changed = true;
        if (newPrice > oldPrice) {
          var name = nv.vehicle.brand_name + ' ' + nv.vehicle.model_name;
          showToast('Lance coberto! ' + name + ' → ' + formatCurrency(newPrice), 'warning', 6000);
          playSound('bid');
        }
      }
      currentVehicles[idx] = nv;
    }
    if (changed) {
      renderVehicles(currentVehicles);
    }
    if (currentVehicle) {
      var updated = currentVehicles.find(function(v) { return v.id === currentVehicle.id; });
      if (updated) {
        var oldDetailPrice = currentVehicle.offer_actual ? currentVehicle.offer_actual.price : currentVehicle.negotiation.value_actual;
        var newDetailPrice = updated.offer_actual ? updated.offer_actual.price : updated.negotiation.value_actual;
        if (newDetailPrice !== oldDetailPrice || updated.negotiation.finish_date_offer !== currentVehicle.negotiation.finish_date_offer) {
          currentVehicle = updated;
          renderVehicleDetail(currentVehicle);
        }
      }
    }
  } catch (err) {}
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

    // Laudo badge
    var laudoBadge = '';
    if (v.precautionary_report && v.precautionary_report.situation === 'aprovado') {
      laudoBadge = '<span class="badge badge-laudo-ok"><i class="fas fa-check-circle"></i> Laudo OK</span>';
    } else if (v.precautionary_report && v.precautionary_report.situation === 'reprovado') {
      laudoBadge = '<span class="badge badge-laudo-fail"><i class="fas fa-times-circle"></i> Reprovado</span>';
    } else {
      laudoBadge = '<span class="badge badge-laudo-none"><i class="fas fa-file-circle-question"></i> Sem Laudo</span>';
    }

    // Urgency class
    var urgencyClass = '';
    var diff = new Date(neg.finish_date_offer) - new Date();
    if (diff > 0 && diff <= 300000) urgencyClass = ' card-urgent';

    var images = getVehicleImages(vehicle);
    html += '<div class="vehicle-card' + urgencyClass + '">';
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
    html += '<button class="card-fav-btn ' + (v.is_favorite ? 'active' : '') + '" onclick="event.stopPropagation();toggleFav(' + v.id + ',this)"><i class="fas fa-heart"></i></button>';
    html += '</div>';
    html += '<div class="vehicle-card-body" onclick="openVehicle(' + v.id + ')">';
    html += '<div class="vehicle-card-header">';
    html += '<div class="vehicle-card-title">' + (vehicle.brand_name || '') + ' ' + (vehicle.model_name || '') + '</div>';
    html += laudoBadge;
    html += '</div>';
    html += '<div class="vehicle-card-subtitle">' + (vehicle.version_name || '') + '</div>';
    html += '<div class="vehicle-card-specs">';
    html += '<span class="spec-tag"><i class="fas fa-calendar"></i> ' + (vehicle.manufacture_year || '') + '/' + (vehicle.model_year || '') + '</span>';
    html += '<span class="spec-tag"><i class="fas fa-road"></i> ' + (vehicle.km ? vehicle.km.toLocaleString() + ' km' : 'N/I') + '</span>';
    html += '<span class="spec-tag"><i class="fas fa-palette"></i> ' + (vehicle.color_name || '') + '</span>';
    if (v.location) html += '<span class="spec-tag"><i class="fas fa-map-marker-alt"></i> ' + v.location + '</span>';
    if (v.plate) html += '<span class="spec-tag spec-plate"><i class="fas fa-id-card"></i> ' + v.plate + '</span>';
    html += '<span class="spec-tag"><i class="fas fa-flag"></i> ' + (v.shop.state || '') + '</span>';
    html += '</div>';
    if (v.comitente) html += '<div class="vehicle-card-comitente"><i class="fas fa-building"></i> ' + v.comitente + '</div>';
    html += '<div class="vehicle-card-footer">';
    html += '<div class="price-block"><div class="price-label">Preço atual</div><div class="price-value">' + formatCurrency(price) + '</div></div>';
    html += '<div class="timer-block"><div class="timer-label">Encerra em</div>';
    html += '<span class="timer-badge ' + (timer.active ? 'active' : '') + '" data-end="' + neg.finish_date_offer + '"><i class="fas fa-clock"></i> <span class="timer-text">' + timer.text + '</span></span>';
    html += '</div></div>';
    html += '<div class="fipe-badge-wrap" id="fipe-card-' + v.id + '"></div>';
    html += '</div>';
    html += '<div class="vehicle-card-bid">';
    html += '<div class="card-bid-row">';
    html += '<input type="text" inputmode="numeric" class="card-bid-input" id="card-bid-' + v.id + '" value="' + formatBidValue(minBid) + '" oninput="maskBidInput(this)" onclick="event.stopPropagation()">';
    html += '<button class="card-bid-btn" onclick="event.stopPropagation();cardBid(' + v.id + ')"><i class="fas fa-gavel"></i> Ofertar</button>';
    html += '<button class="card-autobid-btn" onclick="event.stopPropagation();openAutoBidModal(' + v.id + ')"><i class="fas fa-robot"></i></button>';
    html += '</div>';
    if (neg.enable_buy_now && neg.immediate_sale_price) {
      html += '<button class="card-buynow-btn" onclick="event.stopPropagation();cardBuyNow(' + v.id + ',' + neg.immediate_sale_price + ')"><i class="fas fa-bolt"></i> Comprar Agora ' + formatCurrency(neg.immediate_sale_price) + '</button>';
    }
    if (v.precautionary_report && v.precautionary_report.file_url) {
      html += '<a href="/api/laudo-proxy?url=' + encodeURIComponent(v.precautionary_report.file_url) + '" target="_blank" class="card-laudo-btn" onclick="event.stopPropagation()"><i class="fas fa-file-pdf"></i> Ver Laudo Cautelar</a>';
    }
    html += '</div>';
    html += '</div>';
  });
  grid.innerHTML = html;
  // Preload first 3 images of each card for fast swipe
  vehicles.forEach(function(v) {
    var imgs = getVehicleImages(v.vehicle);
    for (var i = 1; i < Math.min(imgs.length, 4); i++) {
      (new Image()).src = imgs[i];
    }
  });
  loadFipeBadges(vehicles);
}

var urgentAlerted = {};

function startGridTimers() {
  if (gridTimerInterval) clearInterval(gridTimerInterval);
  gridTimerInterval = setInterval(function() {
    document.querySelectorAll('.timer-badge[data-end]').forEach(function(badge) {
      var end = badge.getAttribute('data-end');
      var timer = formatTimer(end);
      var textEl = badge.querySelector('.timer-text');
      if (textEl) textEl.textContent = timer.text;
      badge.className = 'timer-badge ' + (timer.active ? 'active' : '');
      // Urgency alert at 60 seconds
      var diff = new Date(end) - new Date(Date.now() + serverTimeOffset);
      if (diff > 0 && diff <= 60000 && !urgentAlerted[end]) {
        urgentAlerted[end] = true;
        playSound('urgent');
        showToast('Lote encerrando em menos de 1 minuto!', 'warning', 5000);
      }
    });
    // Update card urgency classes
    currentVehicles.forEach(function(v) {
      var diff = new Date(v.negotiation.finish_date_offer) - new Date(Date.now() + serverTimeOffset);
      var card = document.querySelector('[data-card-id="' + v.id + '"]');
      if (card) {
        var parentCard = card.closest('.vehicle-card');
        if (parentCard) {
          if (diff > 0 && diff <= 300000) {
            parentCard.classList.add('card-urgent');
          } else {
            parentCard.classList.remove('card-urgent');
          }
        }
      }
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
        var score = parseFloat(res.data.matchScore) || 0;
        if (score < 0.5) {
          el.innerHTML = '<span class="fipe-badge fipe-na">FIPE indisponível</span>';
          return;
        }
        var fipe = res.data.value;
        var pct = ((fipe - price) / fipe * 100).toFixed(0);
        fipeData[v.id] = parseFloat(pct);
        if (Math.abs(pct) > 60) {
          el.innerHTML = '';
        } else if (score < 0.7) {
          el.innerHTML = '<span class="fipe-badge fipe-na" title="Match aproximado: ' + res.data.model + '"><i class="fas fa-exclamation-triangle"></i> FIPE não confirmada</span>';
        } else if (pct > 0) {
          var cls = pct >= 20 ? 'fipe-great' : 'fipe-good';
          var suffix = score < 0.95 ? ' ~' : '';
          el.innerHTML = '<span class="fipe-badge ' + cls + '"><i class="fas fa-arrow-down"></i> ' + pct + '% abaixo FIPE' + suffix + '</span>';
        } else {
          var suffix2 = score < 0.95 ? ' ~' : '';
          el.innerHTML = '<span class="fipe-badge fipe-bad"><i class="fas fa-arrow-up"></i> ' + Math.abs(pct) + '% acima FIPE' + suffix2 + '</span>';
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
      var score = parseFloat(res.data.matchScore) || 0;
      if (score < 0.5) {
        el.innerHTML = '<div class="fipe-detail-card"><div class="fipe-detail-title"><i class="fas fa-exclamation-triangle"></i> FIPE indisponível</div><div class="fipe-detail-row"><span>Versão não encontrada na tabela FIPE</span></div></div>';
        return;
      }
      var fipe = res.data.value;
      var pct = ((fipe - price) / fipe * 100).toFixed(1);
      var economia = fipe - price;
      if (Math.abs(pct) > 60) {
        el.innerHTML = '';
        return;
      }
      var html = '<div class="fipe-detail-card">';
      html += '<div class="fipe-detail-title"><i class="fas fa-chart-line"></i> Análise FIPE</div>';
      if (score < 0.7) {
        html += '<div class="fipe-detail-row" style="color:#ffd60a"><span><i class="fas fa-exclamation-triangle"></i> Match aproximado — versão exata não encontrada</span></div>';
      }
      html += '<div class="fipe-detail-row"><span>Modelo FIPE</span><span style="font-size:0.8rem;color:#aaa">' + res.data.model + ' (' + res.data.year + ')</span></div>';
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

async function toggleFav(advertisementId, btn) {
  try {
    await api.toggleFavorite(advertisementId);
    btn.classList.toggle('active');
    var v = currentVehicles.find(function(v) { return v.id === advertisementId; });
    if (v) v.is_favorite = !v.is_favorite;
  } catch (err) {}
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
  // Preload next 2 images
  for (var p = 1; p <= 2; p++) {
    var preIdx = (idx + p) % images.length;
    (new Image()).src = images[preIdx];
  }
}

// === SWIPE on card images ===
(function() {
  var startX = 0, startY = 0, swiping = false, swipeTarget = null;

  document.addEventListener('touchstart', function(e) {
    var wrap = e.target.closest('.vehicle-card-img-wrap');
    if (!wrap) { swipeTarget = null; return; }
    swipeTarget = wrap;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    swiping = true;
  }, { passive: true });

  document.addEventListener('touchmove', function(e) {
    if (!swiping || !swipeTarget) return;
    var diffX = Math.abs(e.touches[0].clientX - startX);
    var diffY = Math.abs(e.touches[0].clientY - startY);
    // If horizontal swipe, prevent scroll
    if (diffX > diffY && diffX > 10) {
      e.preventDefault();
    }
  }, { passive: false });

  document.addEventListener('touchend', function(e) {
    if (!swiping || !swipeTarget) return;
    var endX = e.changedTouches[0].clientX;
    var endY = e.changedTouches[0].clientY;
    var diffX = endX - startX;
    var diffY = Math.abs(endY - startY);
    swiping = false;

    // Minimum 40px horizontal, less vertical than horizontal
    if (Math.abs(diffX) > 40 && diffY < Math.abs(diffX)) {
      var cardId = parseInt(swipeTarget.getAttribute('data-card-id'));
      if (diffX < 0) {
        cardCarousel(cardId, 1); // swipe left = next
      } else {
        cardCarousel(cardId, -1); // swipe right = prev
      }
    }
    swipeTarget = null;
  }, { passive: true });
})();

function openVehicle(id) {
  currentVehicle = currentVehicles.find(function(v) { return v.id === id; });
  if (!currentVehicle) return;
  var eventId = currentEvent || localStorage.getItem('lp_event') || '';
  history.pushState(null, '', '#veiculo/' + eventId + '/' + id);
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('page-vehicle').classList.add('active');
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

  var html = '<button class="btn-back-catalog" onclick="navigateTo(\'catalog\')"><i class="fas fa-arrow-left"></i> Voltar aos Lotes</button>';
  html += '<div class="vehicle-gallery" style="position:relative">';
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
  html += '<input type="text" inputmode="numeric" class="bid-input" id="bid-value" placeholder="Sua oferta" value="' + formatBidValue(minBid) + '" oninput="maskBidInput(this)" data-min="' + minBid + '" data-step="' + neg.increment + '">';
  html += '<button class="btn-increment" onclick="incrementBid(' + neg.increment + ')">+' + formatBidValue(neg.increment) + '</button></div>';
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
  html += '</div>';
  if (v.precautionary_report && v.precautionary_report.file_url) {
    html += '<a href="/api/laudo-proxy?url=' + encodeURIComponent(v.precautionary_report.file_url) + '" target="_blank" class="detail-laudo-btn"><i class="fas fa-file-pdf"></i> Ver Laudo Cautelar</a>';
  }
  if (v.comitente) {
    html += '<div class="detail-comitente"><i class="fas fa-building"></i> ' + v.comitente + '</div>';
  }
  html += '</div>';

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
  var current = parseBidValue(input.value);
  input.value = formatBidValue(current + increment);
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

function buildVehicleSnapshot(v) {
  if (!v) return null;
  var vehicle = v.vehicle;
  var photos = [];
  if (vehicle.image_gallery) {
    photos = vehicle.image_gallery.map(function(img) { return img.image || img.thumb || ''; });
  }
  return {
    event_id: parseInt(localStorage.getItem('lp_event')) || null,
    brand: vehicle.brand_name || '',
    model: vehicle.model_name || '',
    version: vehicle.version_name || '',
    year_manufacture: vehicle.manufacture_year || null,
    year_model: vehicle.model_year || null,
    km: vehicle.km || 0,
    color: vehicle.color_name || '',
    fuel: vehicle.fuel_name || '',
    transmission: vehicle.drive_shift_name || '',
    bodywork: vehicle.bodywork_name || '',
    location: v.location || '',
    uf: v.shop ? v.shop.state : '',
    comitente: v.comitente || '',
    plate: v.plate || '',
    photos: photos,
    description: v.description || '',
    initial_price: v.negotiation ? v.negotiation.value_initial : null
  };
}

async function cardBid(advertisementId) {
  if (!requireLogin()) return;
  var input = document.getElementById('card-bid-' + advertisementId);
  var value = parseBidValue(input.value);
  if (!value) return showToast('Informe o valor da oferta', 'error');
  var v = currentVehicles.find(function(x) { return x.id === advertisementId; });
  var name = v ? v.vehicle.brand_name + ' ' + v.vehicle.model_name : '';
  var ok = await showConfirm('Confirmar Oferta', 'Deseja enviar esta oferta?', '<div class="confirm-value">' + formatCurrency(value) + '</div><div class="confirm-vehicle">' + name + '</div>');
  if (!ok) return;
  try {
    var snapshot = buildVehicleSnapshot(v);
    var res = await api.placeBid(advertisementId, value, v ? v.vehicle.brand_name : '', v ? v.vehicle.model_name : '', snapshot);
    if (res.success) {
      showToast('Oferta enviada com sucesso!', 'success');
      playSound('success');
      var savedEvent = localStorage.getItem('lp_event');
      if (savedEvent) loadVehicles(savedEvent);
    } else {
      showToast(res.error || 'Não foi possível enviar a oferta', 'error');
    }
  } catch (err) {
    showToast('Erro ao enviar oferta: ' + err.message, 'error');
  }
}

async function cardBuyNow(advertisementId, value) {
  if (!requireLogin()) return;
  var v = currentVehicles.find(function(x) { return x.id === advertisementId; });
  var name = v ? v.vehicle.brand_name + ' ' + v.vehicle.model_name : '';
  var ok = await showConfirm('Compra Imediata', 'Confirma a compra imediata?', '<div class="confirm-value">' + formatCurrency(value) + '</div><div class="confirm-vehicle">' + name + '</div>');
  if (!ok) return;
  try {
    var snapshot = buildVehicleSnapshot(v);
    var res = await api.buyNow(advertisementId, value, snapshot);
    if (res.success) {
      showToast('Compra realizada com sucesso!', 'success');
      playSound('success');
      var savedEvent = localStorage.getItem('lp_event');
      if (savedEvent) loadVehicles(savedEvent);
    } else {
      showToast(res.error || 'Não foi possível realizar a compra', 'error');
    }
  } catch (err) {
    showToast('Erro: ' + err.message, 'error');
  }
}

var autoBidTargetId = null;

function openAutoBidModal(advertisementId) {
  if (!requireLogin()) return;
  autoBidTargetId = advertisementId;
  var v = currentVehicles.find(function(v) { return v.id === advertisementId; });
  var info = document.getElementById('autobid-vehicle-info');
  if (v) {
    var price = v.offer_actual ? v.offer_actual.price : v.negotiation.value_actual;
    info.innerHTML = '<div class="autobid-info"><strong>' + v.vehicle.brand_name + ' ' + v.vehicle.model_name + '</strong><br><span>Preço atual: ' + formatCurrency(price) + '</span></div>';
    document.getElementById('autobid-max-value').value = price + (v.negotiation.increment * 5);
    document.getElementById('autobid-max-value').min = price + v.negotiation.increment;
    document.getElementById('autobid-max-value').step = v.negotiation.increment;
  }
  document.getElementById('modal-autobid').style.display = 'flex';
}

function closeAutoBidModal() {
  document.getElementById('modal-autobid').style.display = 'none';
  autoBidTargetId = null;
}

async function handleAutoBid(e) {
  e.preventDefault();
  if (!autoBidTargetId) return;
  var maxValue = parseInt(document.getElementById('autobid-max-value').value);
  var tiebreaker = document.getElementById('autobid-tiebreaker').checked;
  if (!maxValue) return showToast('Informe o valor máximo', 'error');
  var ok = await showConfirm('Auto Lance', 'Ativar lance automático?', '<div class="confirm-value">Até ' + formatCurrency(maxValue) + '</div>');
  if (!ok) return;
  try {
    var v = currentVehicles.find(function(x) { return x.id === autoBidTargetId; });
    var snapshot = buildVehicleSnapshot(v);
    var res = await api.placeAutoBid(autoBidTargetId, maxValue, tiebreaker, v ? v.vehicle.brand_name : '', v ? v.vehicle.model_name : '', snapshot);
    if (res.success) {
      showToast('Auto Lance ativado com sucesso!', 'success');
      playSound('success');
      closeAutoBidModal();
      var savedEvent = localStorage.getItem('lp_event');
      if (savedEvent) loadVehicles(savedEvent);
    } else {
      showToast(res.error || 'Não foi possível ativar o auto lance', 'error');
    }
  } catch (err) {
    showToast('Erro: ' + err.message, 'error');
  }
}

async function submitBid(advertisementId) {
  if (!requireLogin()) return;
  var value = parseBidValue(document.getElementById('bid-value').value);
  if (!value) return showToast('Informe o valor da oferta', 'error');
  var ok = await showConfirm('Confirmar Oferta', 'Deseja enviar esta oferta?', '<div class="confirm-value">' + formatCurrency(value) + '</div>');
  if (!ok) return;
  try {
    var v = currentVehicle;
    var snapshot = buildVehicleSnapshot(v);
    var res = await api.placeBid(advertisementId, value, v ? v.vehicle.brand_name : '', v ? v.vehicle.model_name : '', snapshot);
    if (res.success) {
      showToast('Oferta enviada com sucesso!', 'success');
      playSound('success');
    } else {
      showToast(res.error || 'Não foi possível enviar a oferta', 'error');
    }
  } catch (err) {
    showToast('Erro ao enviar oferta: ' + err.message, 'error');
  }
}

async function submitBuyNow(advertisementId, value) {
  if (!requireLogin()) return;
  var ok = await showConfirm('Compra Imediata', 'Confirma a compra imediata?', '<div class="confirm-value">' + formatCurrency(value) + '</div>');
  if (!ok) return;
  try {
    var res = await api.buyNow(advertisementId, value);
    if (res.success) {
      showToast('Compra realizada com sucesso!', 'success');
      playSound('success');
    } else {
      showToast(res.error || 'Não foi possível realizar a compra', 'error');
    }
  } catch (err) {
    showToast('Erro: ' + err.message, 'error');
  }
}

// === FILTER SYSTEM ===
var fipeData = {};

function applyFilters() {
  if (!currentVehicles.length) return;
  var brand = document.getElementById('filter-brand').value;
  var state = document.getElementById('filter-state').value;
  var sort = document.getElementById('filter-sort').value;

  var filtered = currentVehicles.filter(function(v) {
    if (brand && v.vehicle.brand_name !== brand) return false;
    if (state && v.shop.state !== state) return false;
    return true;
  });

  switch (sort) {
    case 'price-asc':
      filtered.sort(function(a, b) { return (a.offer_actual ? a.offer_actual.price : a.negotiation.value_actual) - (b.offer_actual ? b.offer_actual.price : b.negotiation.value_actual); });
      break;
    case 'price-desc':
      filtered.sort(function(a, b) { return (b.offer_actual ? b.offer_actual.price : b.negotiation.value_actual) - (a.offer_actual ? a.offer_actual.price : a.negotiation.value_actual); });
      break;
    case 'time':
      filtered.sort(function(a, b) { return new Date(a.negotiation.finish_date_offer) - new Date(b.negotiation.finish_date_offer); });
      break;
    case 'offers-desc':
      filtered.sort(function(a, b) { return b.offers - a.offers; });
      break;
    case 'fipe-desc':
      filtered.sort(function(a, b) {
        var fA = fipeData[a.id] || 0;
        var fB = fipeData[b.id] || 0;
        return fB - fA;
      });
      break;
  }

  document.getElementById('catalog-count').textContent = filtered.length + ' de ' + currentVehicles.length + ' veículos';
  renderVehicles(filtered);
  startGridTimers();
}

function populateFilters(vehicles) {
  var brands = {};
  var states = {};
  vehicles.forEach(function(v) {
    if (v.vehicle.brand_name) brands[v.vehicle.brand_name] = true;
    if (v.shop && v.shop.state) states[v.shop.state] = true;
  });
  var brandSelect = document.getElementById('filter-brand');
  brandSelect.innerHTML = '<option value="">Todas</option>';
  Object.keys(brands).sort().forEach(function(b) {
    brandSelect.innerHTML += '<option value="' + b + '">' + b + '</option>';
  });
  var stateSelect = document.getElementById('filter-state');
  stateSelect.innerHTML = '<option value="">Todos</option>';
  Object.keys(states).sort().forEach(function(s) {
    stateSelect.innerHTML += '<option value="' + s + '">' + s + '</option>';
  });
}

document.getElementById('filter-sort').addEventListener('change', applyFilters);
document.getElementById('filter-brand').addEventListener('change', applyFilters);
document.getElementById('filter-state').addEventListener('change', applyFilters);

document.getElementById('filter-event').addEventListener('change', function(e) {
  if (e.target.value) {
    currentEvent = e.target.value;
    localStorage.setItem('lp_event', e.target.value);
    loadVehicles(e.target.value);
  }
});

// === DASHBOARD ===
async function loadDashboard() {
  var token = localStorage.getItem('lp_token');
  if (!token) {
    document.getElementById('dash-total-offers').textContent = '0';
    document.getElementById('dash-winning').textContent = '0';
    document.getElementById('dash-losing').textContent = '0';
    document.getElementById('dash-purchases').textContent = '0';
    document.getElementById('dash-disputes-list').innerHTML = '<div class="empty-state" style="padding:40px"><i class="fas fa-user-lock"></i><h3>Faça login</h3><p>Entre na sua conta para ver suas ofertas.</p></div>';
    document.getElementById('dash-offers-list').innerHTML = '';
    return;
  }
  try {
    var res = await fetch('/api/my-bids', { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await res.json();
    if (data.success && data.data) {
      var bids = data.data;
      document.getElementById('dash-total-offers').textContent = bids.length;

      var winning = 0;
      var losing = 0;

      // Disputas em andamento
      var dHtml = '';
      if (bids.length > 0) {
        bids.forEach(function(b) {
          if (b.status === 'ganhando') winning++;
          else if (b.status === 'perdendo') losing++;
          var vehicle = (b.vehicle_brand + ' ' + b.vehicle_model).trim() || 'Veículo #' + b.advertisement_id;
          var valor = parseFloat(b.bid_value);
          var date = new Date(b.created_at).toLocaleString('pt-BR');
          var tipo = b.bid_type === 'automatico' ? '<span style="background:rgba(0,184,148,0.15);color:#00b894;padding:2px 6px;border-radius:4px;font-size:0.7rem">Auto</span>' : '<span style="background:rgba(108,92,231,0.15);color:#a29bfe;padding:2px 6px;border-radius:4px;font-size:0.7rem">Manual</span>';
          var statusColor = b.status === 'ganhando' ? '#00b894' : (b.status === 'perdendo' ? '#ff7675' : '#fdcb6e');
          var statusText = b.status === 'ganhando' ? '🏆 Ganhando' : (b.status === 'perdendo' ? '❌ Perdendo' : '⏳ Pendente');
          var borderColor = b.status === 'ganhando' ? '#00b894' : (b.status === 'perdendo' ? '#ff7675' : '#fdcb6e');
          dHtml += '<div class="dash-offer-item" style="border-left:3px solid '+borderColor+';padding-left:12px">';
          dHtml += '<div class="dash-offer-info">';
          dHtml += '<strong>' + vehicle + '</strong>';
          dHtml += '<span>' + formatCurrency(valor) + ' — ' + date + ' ' + tipo + '</span>';
          dHtml += '</div>';
          dHtml += '<span style="color:'+statusColor+';font-weight:600;font-size:0.8rem">' + statusText + '</span>';
          dHtml += '</div>';
        });
      } else {
        dHtml = '<div class="empty-state" style="padding:30px"><i class="fas fa-inbox"></i><p style="margin-top:8px;color:#8892b0">Nenhuma oferta feita ainda.</p></div>';
      }
      document.getElementById('dash-disputes-list').innerHTML = dHtml;
      document.getElementById('dash-offers-list').innerHTML = '';

      document.getElementById('dash-winning').textContent = winning;
      document.getElementById('dash-losing').textContent = losing;
      document.getElementById('dash-purchases').textContent = '0';
    }
  } catch (err) {
    document.getElementById('dash-disputes-list').innerHTML = '<div class="empty-state" style="padding:40px"><i class="fas fa-exclamation-triangle"></i><h3>Erro</h3><p>' + err.message + '</p></div>';
  }
}

// === SWIPE GESTURE: swipe right on vehicle detail to go back to catalog ===
(function() {
  var touchStartX = 0;
  var touchStartY = 0;
  var touchEndX = 0;
  var touchEndY = 0;

  document.addEventListener('touchstart', function(e) {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
  }, { passive: true });

  document.addEventListener('touchend', function(e) {
    touchEndX = e.changedTouches[0].screenX;
    touchEndY = e.changedTouches[0].screenY;
    var diffX = touchEndX - touchStartX;
    var diffY = Math.abs(touchEndY - touchStartY);
    // Swipe right: at least 80px horizontal, less than 60px vertical
    if (diffX > 80 && diffY < 60) {
      var vehiclePage = document.getElementById('page-vehicle');
      if (vehiclePage && vehiclePage.classList.contains('active')) {
        navigateTo('catalog');
      }
    }
  }, { passive: true });
})();

(async function restoreState() {
  var hash = window.location.hash.replace('#', '');
  if (hash.startsWith('veiculo/')) {
    var parts = hash.split('/');
    var eventId = parts[1];
    var vehicleId = parseInt(parts[2]);
    if (eventId && vehicleId) {
      document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
      document.getElementById('page-catalog').classList.add('active');
      await loadEvents();
      var select = document.getElementById('filter-event');
      if (select) select.value = eventId;
      currentEvent = eventId;
      await loadVehicles(eventId);
      openVehicle(vehicleId);
      return;
    }
  } else if (hash === 'catalog') {
    navigateTo('catalog');
    return;
  } else if (hash === 'how') {
    navigateTo('how');
    return;
  } else if (hash === 'dashboard') {
    navigateTo('dashboard');
    return;
  }
  loadEvents();
})();

window.addEventListener('popstate', function() {
  var hash = window.location.hash.replace('#', '');
  if (hash.startsWith('veiculo/')) {
    var parts = hash.split('/');
    var vehicleId = parseInt(parts[2]);
    if (currentVehicles.length > 0 && vehicleId) {
      openVehicle(vehicleId);
    }
  } else if (hash === 'catalog' || hash === 'how' || hash === 'dashboard') {
    navigateTo(hash);
  } else {
    navigateTo('home');
  }
});
