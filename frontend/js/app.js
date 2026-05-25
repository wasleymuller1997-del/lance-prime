// === SANITIZAÇÃO XSS ===
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  var div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// Alias para uso mais curto
var esc = escapeHtml;

let currentEvent = null;
let currentVehicles = [];
let currentVehicle = null;
let timerInterval = null;
let gridTimerInterval = null;
let ws = null;
let pollingInterval = null;
let myBids = new Set(JSON.parse(localStorage.getItem('lp_mybids') || '[]'));

// Sistema de tracking de lances - guarda o valor do último lance por veículo
// { advertisementId: { value: number, timestamp: number, isWinning: boolean } }
let myBidValues = JSON.parse(localStorage.getItem('lp_mybidvalues') || '{}');

function updateMyBidValue(advertisementId, value) {
  myBidValues[advertisementId] = {
    value: value,
    timestamp: Date.now(),
    isWinning: true,
    coveredBy: null
  };
  localStorage.setItem('lp_mybidvalues', JSON.stringify(myBidValues));
}

function setMyBidLosing(advertisementId, coveredBy) {
  if (myBidValues[advertisementId]) {
    myBidValues[advertisementId].isWinning = false;
    if (coveredBy) myBidValues[advertisementId].coveredBy = coveredBy;
    localStorage.setItem('lp_mybidvalues', JSON.stringify(myBidValues));
  }
}

function setMyBidWinning(advertisementId) {
  if (myBidValues[advertisementId]) {
    myBidValues[advertisementId].isWinning = true;
    myBidValues[advertisementId].coveredBy = null;
    localStorage.setItem('lp_mybidvalues', JSON.stringify(myBidValues));
  }
}

function isMyBidWinning(advertisementId) {
  return myBidValues[advertisementId]?.isWinning === true;
}

function getMyBidValue(advertisementId) {
  return myBidValues[advertisementId]?.value || 0;
}

function getCoveredBy(advertisementId) {
  return myBidValues[advertisementId]?.coveredBy || null;
}

// Extrai quem está liderando a oferta a partir dos dados do veículo (offer_actual
// traz shop.id e user.id de quem fez a oferta mais alta na Dealers).
function extractCoverer(vehicleOrData) {
  var oa = vehicleOrData && vehicleOrData.offer_actual;
  if (oa && oa.shop) {
    return { shop: oa.shop.id, user: oa.user ? oa.user.id : null, price: oa.price };
  }
  return null;
}

// Guarda o último preço de cobertura já notificado por anúncio, pra evitar que
// WebSocket e polling mostrem o MESMO aviso de "coberto" em duplicidade.
var outbidNotified = {};

// Lógica única de cobertura, usada tanto pelo WebSocket quanto pelo polling.
// Só avisa "coberto" se o preço novo for MAIOR que o SEU lance (alguém de fora
// realmente cobriu). Se o preço novo for <= seu lance, é o seu próprio lance
// refletido — você continua levando.
function handleOutbid(adId, newPrice, vehicle) {
  var myLastBid = getMyBidValue(adId);
  if (!(myLastBid > 0)) return;

  if (newPrice > myLastBid) {
    var coverer = extractCoverer(vehicle);
    setMyBidLosing(adId, coverer);
    updateBidStatusBadge(adId);
    updateDetailBidStatus(adId);
    if (outbidNotified[adId] !== newPrice) {
      outbidNotified[adId] = newPrice;
      var name = vehicle.vehicle.brand_name + ' ' + vehicle.vehicle.model_name;
      var who = coverer && coverer.shop ? ' — coberto por outra loja (Dealer #' + coverer.shop + ')' : '';
      showToast('⚠️ Seu lance foi coberto! ' + name + ' → ' + formatCurrency(newPrice) + who, 'error', 9000);
      playSound('outbid');
    }
  } else {
    // Preço <= seu lance: é o seu próprio lance refletido, você continua levando.
    if (!isMyBidWinning(adId)) {
      setMyBidWinning(adId);
      updateBidStatusBadge(adId);
      updateDetailBidStatus(adId);
    }
  }
}

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
    } else if (type === 'outbid') {
      // Som de alerta - seu lance foi coberto (tom descendente)
      gain.gain.value = 0.4;
      osc.frequency.value = 800;
      osc.type = 'sawtooth';
      osc.frequency.exponentialRampToValueAtTime(400, audioCtx.currentTime + 0.3);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
      osc.start(); osc.stop(audioCtx.currentTime + 0.4);
      // Segundo beep de alerta
      setTimeout(function() {
        var osc2 = audioCtx.createOscillator();
        var gain2 = audioCtx.createGain();
        osc2.connect(gain2); gain2.connect(audioCtx.destination);
        gain2.gain.value = 0.4;
        osc2.frequency.value = 600;
        osc2.type = 'sawtooth';
        osc2.frequency.exponentialRampToValueAtTime(300, audioCtx.currentTime + 0.3);
        gain2.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
        osc2.start(); osc2.stop(audioCtx.currentTime + 0.4);
      }, 200);
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

    // Verificar se EU tinha um lance neste veículo e se foi coberto
    if (newPrice > oldPrice && myBids.has(adId)) {
      handleOutbid(adId, newPrice, currentVehicles[idx]);
    } else if (newPrice > oldPrice) {
      // Lance em veículo que não tenho interesse - som discreto apenas
      playSound('bid');
    }

    // Atualizar badge FIPE com o novo preço (recalcula porcentagem)
    updateFipeBadge(adId, newPrice);

    // Atualizar status visual do card
    updateBidStatusBadge(adId);

    renderVehicles(currentVehicles);
    if (currentVehicle && currentVehicle.id === adId) {
      currentVehicle = currentVehicles[idx];
      renderVehicleDetail(currentVehicle);
    }
  }
}

// Função para atualizar o badge de status do lance no card
function updateBidStatusBadge(adId) {
  var badge = document.getElementById('bid-status-' + adId);
  if (!badge) return;

  if (!myBids.has(adId)) {
    badge.style.display = 'none';
    return;
  }

  badge.style.display = 'flex';
  if (isMyBidWinning(adId)) {
    badge.className = 'bid-status-badge winning';
    badge.innerHTML = '<i class="fas fa-trophy"></i> Você está levando';
  } else {
    var cov = getCoveredBy(adId);
    var who = cov && cov.shop ? ' · outra loja' : '';
    badge.className = 'bid-status-badge losing';
    badge.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Lance coberto' + who;
  }
}

// Atualiza o aviso de status na tela de detalhe do veículo (tela de lance).
function updateDetailBidStatus(adId) {
  var el = document.getElementById('detail-bid-status-' + adId);
  if (!el) return;
  if (!myBids.has(adId)) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  if (isMyBidWinning(adId)) {
    el.className = 'detail-bid-status winning';
    el.innerHTML = '<i class="fas fa-trophy"></i> Você está levando este veículo';
  } else {
    var cov = getCoveredBy(adId);
    var who = cov && cov.shop ? ' por outra loja da Dealer (#' + cov.shop + ')' : '';
    el.className = 'detail-bid-status losing';
    el.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Seu lance foi coberto' + who + '. Dê um novo lance para retomar.';
  }
}

// Função para atualizar badge FIPE quando preço muda
function updateFipeBadge(adId, newPrice) {
  if (!window.fipeCache || !window.fipeCache[adId]) return;
  var cache = window.fipeCache[adId];
  var fipe = cache.fipe;
  var score = cache.score;
  var el = document.getElementById('fipe-card-' + adId);
  if (!el || score < 0.7) return;

  var pct = ((fipe - newPrice) / fipe * 100).toFixed(0);
  var economia = fipe - newPrice;
  fipeData[adId] = parseFloat(pct);

  if (pct > 0) {
    var cls = pct >= 20 ? 'fipe-great' : 'fipe-good';
    var suffix = score < 0.95 ? ' ~' : '';
    el.innerHTML = '<span class="fipe-badge ' + cls + '"><i class="fas fa-arrow-down"></i> ' + pct + '% (' + formatCurrency(economia) + ')' + suffix + '</span>';
  } else {
    var suffix2 = score < 0.95 ? ' ~' : '';
    el.innerHTML = '<span class="fipe-badge fipe-bad"><i class="fas fa-arrow-up"></i> ' + Math.abs(pct) + '% acima FIPE' + suffix2 + '</span>';
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
  if (page === 'profile') loadProfile();
  if (page === 'home') loadFeaturedVehicles();
  if (page === 'home') {
    history.pushState(null, '', '/');
  } else if (page !== 'vehicle') {
    history.pushState(null, '', '#' + page);
  }
  window.scrollTo(0, 0);
}

document.getElementById('mobile-toggle').addEventListener('click', function() {
  document.querySelector('.nav-menu').classList.toggle('open');
});

document.querySelectorAll('.nav-link').forEach(function(link) {
  link.addEventListener('click', function(e) {
    e.preventDefault();
    document.querySelector('.nav-menu').classList.remove('open');
    navigateTo(link.dataset.page);
  });
});

document.getElementById('btn-login').addEventListener('click', function() {
  document.querySelector('.nav-menu').classList.remove('open');
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
  if (!endDate) return { text: 'Aguardando', active: false };
  var now = new Date(Date.now() + serverTimeOffset);
  var end = new Date(endDate);
  if (isNaN(end.getTime())) return { text: 'Aguardando', active: false };
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

// CloudFront/S3 são CDNs públicos e rápidos — o navegador busca direto deles
// (em paralelo, com cache de CDN). Antes tudo passava pelo /api/img no Render,
// que baixava e reenviava cada imagem = gargalo na CPU/banda do servidor free.
// Outros domínios (raros) ainda passam pelo proxy.
function imgUrl(rawUrl) {
  if (!rawUrl) return '';
  if (/cloudfront\.net|amazonaws\.com/i.test(rawUrl)) return rawUrl;
  return '/api/img?url=' + encodeURIComponent(rawUrl);
}

function getVehicleImage(vehicle) {
  var gallery = vehicle.image_gallery;
  if (gallery && gallery.length > 0) {
    return imgUrl(gallery[0].thumb || gallery[0].image || '');
  }
  return '';
}

// Miniaturas — pro grid de cards (muito menores, carregam rápido).
function getVehicleThumbs(vehicle) {
  var gallery = vehicle.image_gallery;
  if (gallery && gallery.length > 0) {
    return gallery.map(function(img) {
      return imgUrl(img.thumb || img.image || '');
    }).filter(function(u) { return u; });
  }
  return [];
}

// Imagens em resolução cheia — pra tela de detalhe e lightbox.
function getVehicleImages(vehicle) {
  var gallery = vehicle.image_gallery;
  if (gallery && gallery.length > 0) {
    return gallery.map(function(img) {
      return imgUrl(img.image || img.thumb || '');
    }).filter(function(u) { return u; });
  }
  return [];
}

function cleanEventName(name) {
  return (name || '')
    .replace(/dealers\s*club/gi, 'LancePrime')
    .replace(/dealers/gi, 'LancePrime')
    .replace(/venda\s*direta/gi, 'Venda Direta')
    .trim();
}

function formatEventDate(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  var now = new Date(Date.now() + serverTimeOffset);
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var diffDays = Math.round((target - today) / (1000 * 60 * 60 * 24));
  var hh = String(d.getHours()).padStart(2, '0');
  var mm = String(d.getMinutes()).padStart(2, '0');
  var timeStr = hh + 'h' + (mm !== '00' ? mm : '');
  if (diffDays === 0) return 'Hoje, ' + timeStr;
  if (diffDays === 1) return 'Amanhã, ' + timeStr;
  if (diffDays > 1 && diffDays < 7) {
    var dias = ['dom','seg','ter','qua','qui','sex','sáb'];
    return dias[d.getDay()] + ', ' + timeStr;
  }
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + ', ' + timeStr;
}

function formatTimeDiff(diff) {
  if (diff <= 0) return '—';
  var days = Math.floor(diff / 86400000);
  var hours = Math.floor((diff % 86400000) / 3600000);
  var minutes = Math.floor((diff % 3600000) / 60000);
  var seconds = Math.floor((diff % 60000) / 1000);
  if (days > 0) return days + 'd ' + hours + 'h';
  if (hours > 0) return hours + 'h ' + String(minutes).padStart(2, '0') + 'min';
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}

// status por HORÁRIO (não por dia de calendário):
//  'upcoming' = ainda não chegou a hora do pregão ao vivo (EM BREVE)
//  'live'     = pregão ao vivo em andamento (entre o início ao vivo e o encerramento)
//  'ended'    = já encerrou
// liveStart = horário em que o evento fica ao vivo (finish_date_event)
// endDate   = encerramento real (finish_date_display)
function getEventState(liveStart, endDate) {
  var now = new Date(Date.now() + serverTimeOffset);
  var start = liveStart ? new Date(liveStart) : null;
  var end = endDate ? new Date(endDate) : null;
  var hasStart = start && !isNaN(start.getTime());
  var hasEnd = end && !isNaN(end.getTime());
  if (!hasStart && !hasEnd) return { status: 'live', text: '—', active: true };
  if (hasEnd && end - now <= 0) return { status: 'ended', text: 'Encerrado', active: false };
  if (hasStart && now < start) {
    // ainda não começou: conta o tempo até ficar ao vivo
    return { status: 'upcoming', text: formatTimeDiff(start - now), active: true };
  }
  // ao vivo: conta o tempo até o encerramento
  var target = hasEnd ? end : start;
  return { status: 'live', text: formatTimeDiff(target - now), active: true };
}

var EVENT_STATUS_LABEL = { live: 'AO VIVO', upcoming: 'EM BREVE', ended: 'ENCERRADO' };

var eventTabsTimerInterval = null;
function startEventTabsTimer() {
  if (eventTabsTimerInterval) clearInterval(eventTabsTimerInterval);
  eventTabsTimerInterval = setInterval(function() {
    document.querySelectorAll('.event-tab[data-end]').forEach(function(tab) {
      var state = getEventState(tab.getAttribute('data-start'), tab.getAttribute('data-end'));
      var el = tab.querySelector('.event-tab-countdown-text');
      if (el) el.textContent = state.text;
      var cdEl = tab.querySelector('.event-tab-countdown');
      if (cdEl) cdEl.classList.toggle('ended', !state.active);
      var badge = tab.querySelector('.event-tab-status');
      if (badge) {
        badge.classList.remove('live', 'upcoming', 'ended');
        badge.classList.add(state.status);
        var bt = badge.querySelector('.event-tab-status-text');
        if (bt) bt.textContent = EVENT_STATUS_LABEL[state.status];
      }
    });
  }, 1000);
}

// ===== Banner promocional (carrossel girando) =====
// Edite os slides aqui. type 'text' usa o gradiente da marca (icon/title/subtitle).
// type 'image' usa imagem de fundo — coloque a URL em "image" para o slide aparecer.
var PROMO_SLIDES = [
  { type: 'image', image: 'assets/banner-2.svg?v=3', alt: 'Até 60% abaixo da FIPE — margem cheia pra revenda' },
  { type: 'image', image: 'assets/banner-3.svg?v=3', alt: 'Dispute ao vivo e garanta o melhor preço' },
  { type: 'image', image: 'assets/banner-4.svg?v=3', alt: 'Abasteça o seu pátio com as melhores ofertas' },
  { type: 'image', image: 'assets/banner-5.svg?v=3', alt: 'Achou, deu lance, levou pro seu pátio' },
  { type: 'image', image: 'assets/banner-6.svg?v=3', alt: 'Transporte e logística pra todo o Brasil' },
  { type: 'image', image: 'assets/banner-1.svg?v=3', alt: 'Abasteça a sua loja com margem de verdade' }
];

var promoTimer = null;
var promoIndex = 0;
function initPromoBanner() {
  var banner = document.getElementById('promo-banner');
  if (!banner) return;
  // Só renderiza slides de texto e slides de imagem que já têm arte definida —
  // assim nenhum banner vazio/quebrado aparece no ar antes de você subir a imagem.
  var slides = PROMO_SLIDES.filter(function(s) {
    return s.type === 'text' || (s.type === 'image' && s.image);
  });
  if (slides.length === 0) { banner.innerHTML = ''; return; }

  var track = '<div class="promo-track">';
  slides.forEach(function(s) {
    if (s.type === 'image') {
      track += '<div class="promo-slide image" role="img" aria-label="' + esc(s.alt || '') + '" style="background-image:url(\'' + esc(s.image) + '\')"></div>';
    } else {
      track += '<div class="promo-slide text">' +
        (s.icon ? '<div class="promo-slide-icon"><i class="fas ' + esc(s.icon) + '"></i></div>' : '') +
        '<div class="promo-slide-title">' + esc(s.title || '') + '</div>' +
        (s.subtitle ? '<div class="promo-slide-subtitle">' + esc(s.subtitle) + '</div>' : '') +
      '</div>';
    }
  });
  track += '</div>';

  banner.innerHTML = track;

  // Bolinhas ficam FORA do banner (logo abaixo), pra não cobrir os selos da arte.
  var dotsEl = document.getElementById('promo-dots');
  if (dotsEl) {
    if (slides.length > 1) {
      var dots = '';
      slides.forEach(function(_, i) {
        dots += '<button class="promo-dot' + (i === 0 ? ' active' : '') + '" data-i="' + i + '" aria-label="Ir para o slide ' + (i + 1) + '"></button>';
      });
      dotsEl.innerHTML = dots;
      dotsEl.style.display = 'flex';
    } else {
      dotsEl.innerHTML = '';
      dotsEl.style.display = 'none';
    }
  }

  promoIndex = 0;
  var trackEl = banner.querySelector('.promo-track');
  function go(i) {
    promoIndex = (i + slides.length) % slides.length;
    trackEl.style.transform = 'translateX(-' + (promoIndex * 100) + '%)';
    if (dotsEl) dotsEl.querySelectorAll('.promo-dot').forEach(function(d, di) {
      d.classList.toggle('active', di === promoIndex);
    });
  }
  function restart() {
    if (promoTimer) clearInterval(promoTimer);
    if (slides.length > 1) promoTimer = setInterval(function() { go(promoIndex + 1); }, 5000);
  }
  if (dotsEl) dotsEl.querySelectorAll('.promo-dot').forEach(function(d) {
    d.addEventListener('click', function() { go(parseInt(d.getAttribute('data-i'), 10)); restart(); });
  });
  var startX = null;
  banner.addEventListener('touchstart', function(e) { startX = e.touches[0].clientX; }, { passive: true });
  banner.addEventListener('touchend', function(e) {
    if (startX === null) return;
    var dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 40) { go(promoIndex + (dx < 0 ? 1 : -1)); restart(); }
    startX = null;
  });
  restart();
}

function renderEventTabs(events) {
  var container = document.getElementById('event-tabs');
  if (!container) return;
  if (!events || events.length === 0) {
    container.innerHTML = '<div class="event-tabs-empty">Nenhum evento ativo no momento.</div>';
    return;
  }
  var html = '';
  events.forEach(function(event) {
    var name = cleanEventName(event.name);
    var liveStart = event.finish_date_event || event.finish_date_display;
    var endDate = event.finish_date_display || event.finish_date_event;
    var dateLabel = formatEventDate(liveStart);
    var state = getEventState(liveStart, endDate);
    html += '<div class="event-tab" data-event-id="' + esc(event.id) + '" data-start="' + esc(liveStart || '') + '" data-end="' + esc(endDate || '') + '">' +
      '<div class="event-tab-top">' +
        '<span class="event-tab-status event-tab-live ' + state.status + '"><span class="dot"></span><span class="event-tab-status-text">' + EVENT_STATUS_LABEL[state.status] + '</span></span>' +
        (dateLabel ? '<span class="event-tab-date">' + esc(dateLabel) + '</span>' : '') +
      '</div>' +
      '<div class="event-tab-name">' + esc(name) + '</div>' +
      '<div class="event-tab-countdown' + (state.active ? '' : ' ended') + '"><i class="fas fa-clock"></i> <span class="event-tab-countdown-text">' + esc(state.text) + '</span></div>' +
    '</div>';
  });
  container.innerHTML = html;
  if (currentEvent) {
    var activeTab = container.querySelector('.event-tab[data-event-id="' + currentEvent + '"]');
    if (activeTab) activeTab.classList.add('active');
  }
  startEventTabsTimer();
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
        opt.textContent = cleanEventName(event.name);
        select.appendChild(opt);
      });
      document.getElementById('stat-events').textContent = res.data.length;
      renderEventTabs(res.data);
    }
  } catch (err) {
    console.error('Erro ao carregar eventos:', err);
    var container = document.getElementById('event-tabs');
    if (container) container.innerHTML = '<div class="event-tabs-empty">Erro ao carregar eventos.</div>';
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

// === Veículos em destaque na home ===
async function loadFeaturedVehicles() {
  var section = document.getElementById('featured-section');
  var grid = document.getElementById('featured-grid');
  if (!grid) return;
  if (grid.dataset.loaded === '1') { if (section) section.style.display = 'block'; return; }
  grid.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
  try {
    var ev = await api.getEvents();
    if (!ev.success || !ev.data || !ev.data.length) { if (section) section.style.display = 'none'; return; }
    // Junta os veículos de todos os eventos ativos (pro total certo e variedade)
    var all = [];
    for (var i = 0; i < ev.data.length; i++) {
      try {
        var r = await api.getEventVehicles(ev.data[i].id);
        if (r.success && r.data) {
          var eid = String(ev.data[i].id);
          r.data.forEach(function(x) { x.__eventId = eid; });
          all = all.concat(r.data);
        }
      } catch (e2) { /* ignora evento que falhar */ }
    }
    var statV = document.getElementById('stat-vehicles');
    if (statV) statV.textContent = all.length || '-';
    if (!all.length) { if (section) section.style.display = 'none'; return; }
    window.featuredVehicles = all;
    // Mostra os "mais top": maior valor primeiro
    var top = all.slice().sort(function(a, b) {
      var pa = a.offer_actual ? a.offer_actual.price : a.negotiation.value_actual;
      var pb = b.offer_actual ? b.offer_actual.price : b.negotiation.value_actual;
      return (pb || 0) - (pa || 0);
    }).slice(0, 6);
    renderFeatured(top);
    grid.dataset.loaded = '1';
    if (section) section.style.display = 'block';
  } catch (e) {
    if (section) section.style.display = 'none';
  }
}

function renderFeatured(vehicles) {
  var html = '';
  vehicles.forEach(function(v) {
    var vehicle = v.vehicle;
    var neg = v.negotiation;
    var price = v.offer_actual ? v.offer_actual.price : neg.value_actual;
    var timer = formatTimer(neg.finish_date_offer);
    var imgs = getVehicleThumbs(vehicle);
    var img = imgs.length ? imgs[0] : '';
    html += '<div class="featured-card" onclick="openFeatured(' + v.id + ')">';
    html += '<div class="featured-card-img" data-fc-id="' + v.id + '">';
    if (img) html += '<img src="' + esc(img) + '" data-fc-index="0" data-fc-images=\'' + JSON.stringify(imgs).replace(/'/g, '&#39;') + '\' alt="' + esc(vehicle.brand_name || '') + '" loading="lazy">';
    if (imgs.length > 1) {
      html += '<button class="carousel-btn prev" onclick="event.stopPropagation();featuredCarousel(' + v.id + ',-1)"><i class="fas fa-chevron-left"></i></button>';
      html += '<button class="carousel-btn next" onclick="event.stopPropagation();featuredCarousel(' + v.id + ',1)"><i class="fas fa-chevron-right"></i></button>';
      html += '<div class="carousel-dots">';
      for (var di = 0; di < Math.min(imgs.length, 8); di++) html += '<span class="carousel-dot' + (di === 0 ? ' active' : '') + '"></span>';
      html += '</div>';
    }
    if (timer.active) html += '<span class="badge badge-live" style="position:absolute;top:10px;left:10px"><i class="fas fa-circle"></i> AO VIVO</span>';
    html += '</div>';
    html += '<div class="featured-card-body">';
    html += '<div class="featured-card-title">' + esc(vehicle.brand_name || '') + ' ' + esc(vehicle.model_name || '') + '</div>';
    html += '<div class="featured-card-sub">' + esc(vehicle.version_name || '') + (vehicle.model_year ? ' • ' + esc(vehicle.model_year) : '') + '</div>';
    html += '<div class="featured-card-price">' + formatCurrency(price) + '</div>';
    html += '</div></div>';
  });
  document.getElementById('featured-grid').innerHTML = html;
}

function featuredCarousel(id, direction) {
  var wrap = document.querySelector('[data-fc-id="' + id + '"]');
  if (!wrap) return;
  var img = wrap.querySelector('img');
  var images = JSON.parse(img.getAttribute('data-fc-images'));
  var idx = parseInt(img.getAttribute('data-fc-index')) + direction;
  if (idx < 0) idx = images.length - 1;
  if (idx >= images.length) idx = 0;
  img.src = images[idx];
  img.setAttribute('data-fc-index', idx);
  wrap.querySelectorAll('.carousel-dot').forEach(function(d, i) { d.classList.toggle('active', i === idx); });
  for (var p = 1; p <= 2; p++) { (new Image()).src = images[(idx + p) % images.length]; }
}

function openFeatured(id) {
  if (window.featuredVehicles) {
    currentVehicles = window.featuredVehicles;
    var v = window.featuredVehicles.find(function(x) { return x.id === id; });
    if (v && v.__eventId) currentEvent = v.__eventId;
  }
  openVehicle(id);
}

function startPolling(eventId) {
  stopPolling();
  // Polling a cada 10 segundos como backup do WebSocket (reduz carga na Dealers)
  pollingInterval = setInterval(function() { pollVehicles(eventId); }, 10000);
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

    if (newVehicles.length !== currentVehicles.length) {
      currentVehicles = newVehicles;
      renderVehicles(currentVehicles);
      return;
    }

    for (var i = 0; i < newVehicles.length; i++) {
      var nv = newVehicles[i];
      var idx = currentVehicles.findIndex(function(v) { return v.id === nv.id; });
      if (idx === -1) { currentVehicles = newVehicles; renderVehicles(currentVehicles); return; }
      var old = currentVehicles[idx];
      var oldPrice = old.offer_actual ? old.offer_actual.price : old.negotiation.value_actual;
      var newPrice = nv.offer_actual ? nv.offer_actual.price : nv.negotiation.value_actual;

      if (newPrice > oldPrice && myBids.has(nv.id)) {
        // Mesma lógica do WebSocket: só avisa "coberto" se alguém de fora
        // superou o SEU lance. Se o preço subiu por causa do seu próprio
        // lance, não dispara aviso falso de "não está mais levando".
        handleOutbid(nv.id, newPrice, nv);
        var statusEl = document.getElementById('status-' + nv.id);
        if (statusEl) {
          if (isMyBidWinning(nv.id)) {
            statusEl.className = 'badge badge-winning';
            statusEl.innerHTML = '<i class="fas fa-trophy"></i> Levando';
          } else {
            statusEl.className = 'badge badge-losing';
            statusEl.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Coberto';
          }
        }
      }

      // Atualizar preço no DOM sem re-render
      if (newPrice !== oldPrice) {
        var priceEl = document.getElementById('price-' + nv.id);
        if (priceEl) {
          priceEl.textContent = formatCurrency(newPrice);
        }
        var minBid = newPrice + nv.negotiation.increment;
        var inputEl = document.getElementById('card-bid-' + nv.id);
        if (inputEl && document.activeElement !== inputEl) {
          inputEl.value = formatBidValue(minBid);
        }
      }

      // Atualizar timer no DOM quando finish_date_offer muda
      if (nv.negotiation.finish_date_offer !== old.negotiation.finish_date_offer) {
        var card = document.querySelector('[data-vehicle-id="' + nv.id + '"]');
        if (card) {
          var badge = card.querySelector('.timer-badge[data-end]');
          if (badge) badge.setAttribute('data-end', nv.negotiation.finish_date_offer);
        }
      }

      currentVehicles[idx] = nv;
    }

    if (currentVehicle) {
      var updated = currentVehicles.find(function(v) { return v.id === currentVehicle.id; });
      if (updated) {
        var oldDP = currentVehicle.offer_actual ? currentVehicle.offer_actual.price : currentVehicle.negotiation.value_actual;
        var newDP = updated.offer_actual ? updated.offer_actual.price : updated.negotiation.value_actual;
        if (newDP !== oldDP || updated.negotiation.finish_date_offer !== currentVehicle.negotiation.finish_date_offer) {
          currentVehicle = updated;
          renderVehicleDetail(currentVehicle);
        }
      }
    }
  } catch (err) {}
}

// Expande/recolhe a descrição completa direto no card, sem abrir o detalhe.
function toggleCardDesc(id) {
  var el = document.getElementById('desc-' + id);
  if (!el) return;
  var expanded = el.classList.toggle('expanded');
  var btn = document.getElementById('desctoggle-' + id);
  if (btn) btn.textContent = expanded ? 'ver menos' : 'ver mais';
}

// Clique no corpo do card: se o toque foi na área da descrição (texto ou
// botão "ver mais"), apenas expande/recolhe ali mesmo; caso contrário, abre
// o detalhe do veículo. Robusto no mobile (não depende de stopPropagation).
function cardBodyClick(e, id) {
  if (e.target.closest('.vehicle-card-desc-wrap')) {
    e.stopPropagation();
    toggleCardDesc(id);
    return;
  }
  openVehicle(id);
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
    if (myBids.has(v.id)) badges += '<span class="badge badge-winning" id="status-' + v.id + '"><i class="fas fa-trophy"></i> Levando</span>';
    if (v.offers > 0) badges += '<span class="badge badge-offers">' + esc(v.offers) + ' oferta' + (v.offers > 1 ? 's' : '') + '</span>';

    // Laudo badge
    var laudoBadge = '';
    if (v.precautionary_report && v.precautionary_report.situation === 'aprovado') {
      laudoBadge = '<span class="badge badge-laudo-ok"><i class="fas fa-check-circle"></i> Laudo OK</span>';
    } else if (v.precautionary_report && v.precautionary_report.situation === 'aprovado_com_apontamento') {
      laudoBadge = '<span class="badge badge-laudo-warn"><i class="fas fa-exclamation-triangle"></i> Aprovado c/ apontamento</span>';
    } else if (v.precautionary_report && v.precautionary_report.situation === 'reprovado') {
      laudoBadge = '<span class="badge badge-laudo-fail"><i class="fas fa-times-circle"></i> Reprovado</span>';
    } else {
      laudoBadge = '<span class="badge badge-laudo-none"><i class="fas fa-file-circle-question"></i> Sem Laudo</span>';
    }

    // IPVA badge
    var ipvaBadge = '';
    var desc = (vehicle.description || '').toUpperCase();
    if (desc.includes('IPVA') && desc.includes('PAGO')) {
      ipvaBadge = '<span class="badge badge-ipva-ok"><i class="fas fa-file-invoice-dollar"></i> IPVA Pago</span>';
    } else if (desc.includes('IPVA') && (desc.includes('PENDENTE') || desc.includes('VENCIDO'))) {
      ipvaBadge = '<span class="badge badge-ipva-pending"><i class="fas fa-exclamation-triangle"></i> IPVA Pendente</span>';
    }

    // Urgency class
    var urgencyClass = '';
    var diff = new Date(neg.finish_date_offer) - new Date();
    if (diff <= 0) urgencyClass = ' card-ended';

    var images = getVehicleThumbs(vehicle);
    html += '<div class="vehicle-card' + urgencyClass + '" data-vehicle-id="' + v.id + '">';
    html += '<div class="vehicle-card-img-wrap" data-card-id="' + v.id + '" onclick="openVehicle(' + v.id + ')">';
    if (images.length > 0) {
      html += '<img class="vehicle-card-img" src="' + esc(images[0]) + '" alt="' + esc(vehicle.brand_name || '') + '" loading="lazy" data-index="0" data-images=\'' + JSON.stringify(images).replace(/'/g, '&#39;') + '\'>';
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
    html += '<div class="vehicle-card-body" onclick="cardBodyClick(event,' + v.id + ')">';
    html += '<div class="vehicle-card-header">';
    html += '<div class="vehicle-card-title">' + esc(vehicle.brand_name || '') + ' ' + esc(vehicle.model_name || '') + '</div>';
    html += laudoBadge;
    html += ipvaBadge;
    html += '</div>';
    html += '<div class="vehicle-card-subtitle">' + esc(vehicle.version_name || '') + '</div>';
    html += '<div class="vehicle-card-specs">';
    html += '<span class="spec-tag"><i class="fas fa-calendar"></i> ' + esc(vehicle.manufacture_year || '') + '/' + esc(vehicle.model_year || '') + '</span>';
    html += '<span class="spec-tag"><i class="fas fa-road"></i> ' + (vehicle.km ? vehicle.km.toLocaleString() + ' km' : 'N/I') + '</span>';
    html += '<span class="spec-tag"><i class="fas fa-palette"></i> ' + esc(vehicle.color_name || '') + '</span>';
    if (v.location) html += '<span class="spec-tag"><i class="fas fa-map-marker-alt"></i> ' + esc(v.location) + '</span>';
    if (v.plate) html += '<span class="spec-tag spec-plate"><i class="fas fa-id-card"></i> ' + esc(v.plate) + '</span>';
    html += '<span class="spec-tag"><i class="fas fa-flag"></i> ' + esc(v.shop.state || '') + '</span>';
    html += '</div>';
    if (v.comitente) html += '<div class="vehicle-card-comitente"><i class="fas fa-building"></i> ' + esc(v.comitente) + '</div>';
    if (v.description) {
      var descLong = v.description.length > 140;
      if (descLong) {
        html += '<div class="vehicle-card-desc-wrap" title="Toque para ver a descrição completa">';
        html += '<div class="vehicle-card-description" id="desc-' + v.id + '"><i class="fas fa-clipboard-list"></i> ' + esc(v.description) + '</div>';
        html += '<button type="button" class="desc-toggle" id="desctoggle-' + v.id + '">ver mais</button>';
        html += '</div>';
      } else {
        html += '<div class="vehicle-card-description"><i class="fas fa-clipboard-list"></i> ' + esc(v.description) + '</div>';
      }
    }
    html += '<div class="vehicle-card-footer">';
    html += '<div class="price-block"><div class="price-label">Preço atual</div><div class="price-value" id="price-' + v.id + '">' + formatCurrency(price) + '</div></div>';
    html += '<div class="timer-block"><div class="timer-label">Encerra em</div>';
    html += '<span class="timer-badge ' + (timer.active ? 'active' : '') + '" data-end="' + esc(neg.finish_date_offer) + '"><i class="fas fa-clock"></i> <span class="timer-text">' + esc(timer.text) + '</span></span>';
    html += '</div></div>';
    html += '<div class="fipe-badge-wrap" id="fipe-card-' + v.id + '"></div>';
    html += '</div>';

    // Badge de status do lance (você está levando / lance coberto)
    var bidStatusClass = '';
    var bidStatusHtml = '';
    var bidStatusDisplay = 'none';
    if (myBids.has(v.id)) {
      bidStatusDisplay = 'flex';
      if (isMyBidWinning(v.id)) {
        bidStatusClass = 'winning';
        bidStatusHtml = '<i class="fas fa-trophy"></i> Você está levando';
      } else {
        bidStatusClass = 'losing';
        bidStatusHtml = '<i class="fas fa-exclamation-triangle"></i> Lance coberto';
      }
    }
    html += '<div class="bid-status-badge ' + bidStatusClass + '" id="bid-status-' + v.id + '" style="display:' + bidStatusDisplay + '">' + bidStatusHtml + '</div>';

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
      html += '<a href="#" class="card-laudo-btn" onclick="event.stopPropagation();event.preventDefault();openLaudo(\'' + encodeURIComponent(v.precautionary_report.file_url) + '\')"><i class="fas fa-file-pdf"></i> Ver Laudo Cautelar</a>';
    }
    html += '</div>';
    html += '</div>';
  });
  grid.innerHTML = html;
  if (isTestMode()) grid.insertAdjacentHTML('afterbegin', testCardHtml());
  // Preload next thumbs de cada card pra swipe rápido (thumbs são leves)
  vehicles.forEach(function(v) {
    var imgs = getVehicleThumbs(v.vehicle);
    for (var i = 1; i < Math.min(imgs.length, 4); i++) {
      (new Image()).src = imgs[i];
    }
  });
  // Pequeno delay para garantir que o DOM foi atualizado
  setTimeout(function() { loadFipeBadges(vehicles); }, 10);
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
    });
  }, 1000);
}

function loadFipeBadges(vehicles) {
  vehicles.forEach(function(v) {
    var vehicle = v.vehicle;
    var neg = v.negotiation;
    var price = v.offer_actual ? v.offer_actual.price : neg.value_actual;

    // Se já tem cache, usa direto sem chamar API
    if (window.fipeCache && window.fipeCache[v.id]) {
      var cache = window.fipeCache[v.id];
      var el = document.getElementById('fipe-card-' + v.id);
      if (!el) return;
      var fipe = cache.fipe;
      var score = cache.score;
      if (score < 0.7) {
        el.innerHTML = '<span class="fipe-badge fipe-na"><i class="fas fa-exclamation-triangle"></i> FIPE não confirmada</span>';
      } else {
        var pct = ((fipe - price) / fipe * 100).toFixed(0);
        var economia = fipe - price;
        fipeData[v.id] = parseFloat(pct);
        if (pct > 0) {
          var cls = pct >= 20 ? 'fipe-great' : 'fipe-good';
          var suffix = score < 0.95 ? ' ~' : '';
          el.innerHTML = '<span class="fipe-badge ' + cls + '"><i class="fas fa-arrow-down"></i> ' + pct + '% (' + formatCurrency(economia) + ')' + suffix + '</span>';
        } else {
          var suffix2 = score < 0.95 ? ' ~' : '';
          el.innerHTML = '<span class="fipe-badge fipe-bad"><i class="fas fa-arrow-up"></i> ' + Math.abs(pct) + '% acima FIPE' + suffix2 + '</span>';
        }
      }
      return;
    }

    // Se não tem cache, chama a API
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
        var economia = fipe - price;
        fipeData[v.id] = parseFloat(pct);
        // Guardar dados da FIPE para atualização em tempo real
        if (!window.fipeCache) window.fipeCache = {};
        window.fipeCache[v.id] = { fipe: fipe, score: score };
        if (score < 0.7) {
          el.innerHTML = '<span class="fipe-badge fipe-na" title="Match aproximado: ' + res.data.model + '"><i class="fas fa-exclamation-triangle"></i> FIPE não confirmada</span>';
        } else if (pct > 0) {
          var cls = pct >= 20 ? 'fipe-great' : 'fipe-good';
          var suffix = score < 0.95 ? ' ~' : '';
          el.innerHTML = '<span class="fipe-badge ' + cls + '"><i class="fas fa-arrow-down"></i> ' + pct + '% (' + formatCurrency(economia) + ')' + suffix + '</span>';
        } else {
          var suffix2 = score < 0.95 ? ' ~' : '';
          el.innerHTML = '<span class="fipe-badge fipe-bad"><i class="fas fa-arrow-up"></i> ' + Math.abs(pct) + '% acima FIPE' + suffix2 + '</span>';
        }
      } else {
        el.innerHTML = '<span class="fipe-badge fipe-na">FIPE indisponível</span>';
      }
    }).catch(function(err) {
      console.error('Erro ao carregar FIPE para veículo ' + v.id + ':', err);
      var el = document.getElementById('fipe-card-' + v.id);
      if (el) el.innerHTML = '<span class="fipe-badge fipe-na">FIPE indisponível</span>';
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
    thumbsHtml += '<img src="' + esc(url) + '" onclick="changeImage(\'' + esc(url).replace(/'/g, "\\'") + '\')" class="' + (i === 0 ? 'active' : '') + '" loading="lazy">';
  });

  var html = '<button class="btn-back-catalog" onclick="navigateTo(\'catalog\')"><i class="fas fa-arrow-left"></i> Voltar aos Lotes</button>';
  html += '<div class="vehicle-gallery" style="position:relative">';
  html += '<img id="main-image" src="' + esc(mainImg) + '" alt="' + esc(vehicle.brand_name || '') + '" data-index="0" onclick="openLightbox()">';
  if (images.length > 1) {
    html += '<button class="carousel-btn prev" onclick="galleryNav(-1)"><i class="fas fa-chevron-left"></i></button>';
    html += '<button class="carousel-btn next" onclick="galleryNav(1)"><i class="fas fa-chevron-right"></i></button>';
  }
  html += '<div class="vehicle-thumbnails">' + thumbsHtml + '</div></div>';
  html += '<div class="vehicle-sidebar">';
  html += '<h2>' + esc(vehicle.brand_name || '') + ' ' + esc(vehicle.model_name || '') + '</h2>';
  html += '<div class="subtitle">' + esc(vehicle.version_name || '') + ' — ' + esc(vehicle.manufacture_year) + '/' + esc(vehicle.model_year) + '</div>';
  html += '<div class="bid-section">';
  html += '<div class="bid-row"><span class="label">Preço Atual</span><span class="value highlight">' + formatCurrency(price) + '</span></div>';
  html += '<div class="bid-row"><span class="label">Ofertas</span><span class="value">' + esc(v.offers) + '</span></div>';
  html += '<div class="bid-row"><span class="label">Incremento mínimo</span><span class="value">' + formatCurrency(neg.increment) + '</span></div>';
  html += '</div>';
  html += '<div class="detail-bid-status" id="detail-bid-status-' + v.id + '" style="display:none"></div>';
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
  html += '<div class="spec-row"><span class="label">Categoria</span><span>' + esc(vehicle.category_name || '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">Cor</span><span>' + esc(vehicle.color_name || '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">Câmbio</span><span>' + esc(vehicle.drive_shift_name || '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">Combustível</span><span>' + esc(vehicle.fuel_name || '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">KM</span><span>' + (vehicle.km ? vehicle.km.toLocaleString() : '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">Vendedor</span><span>' + esc(v.shop.name || '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">Local</span><span>' + esc(v.shop.city || '') + '/' + esc(v.shop.state || '') + '</span></div>';
  html += '</div>';
  if (v.precautionary_report && v.precautionary_report.file_url) {
    html += '<a href="#" class="detail-laudo-btn" onclick="event.preventDefault();openLaudo(\'' + encodeURIComponent(v.precautionary_report.file_url) + '\')"><i class="fas fa-file-pdf"></i> Ver Laudo Cautelar</a>';
  }
  if (v.comitente) {
    html += '<div class="detail-comitente"><i class="fas fa-building"></i> ' + esc(v.comitente) + '</div>';
  }
  if (v.description) {
    html += '<div class="detail-description"><div class="detail-description-title"><i class="fas fa-clipboard-list"></i> Observações do veículo</div><div class="detail-description-body">' + esc(v.description).replace(/\n/g, '<br>') + '</div></div>';
  }
  html += '<div id="bid-history"></div>';
  html += '</div>';

  document.getElementById('vehicle-detail').innerHTML = html;
  updateDetailBidStatus(v.id);
  loadFipeDetail(v);
  loadBidHistory(v.id);
}

// Histórico de lances do veículo (ofertas anônimas, com spread aplicado).
async function loadBidHistory(adId) {
  var el = document.getElementById('bid-history');
  if (!el) return;
  try {
    var res = await fetch('/api/vehicles/' + adId + '/offers');
    var data = await res.json();
    var offers = (data.success && data.data) ? data.data : [];
    if (offers.length === 0) { el.innerHTML = ''; return; }
    var rows = '';
    offers.forEach(function(o) {
      var when = o.created_at ? new Date(o.created_at).toLocaleString('pt-BR') : '';
      var buyer = o.buyerId ? '<span style="font-size:0.68rem;color:#8892b0">Comprador #' + esc(o.buyerId) + '</span>' : '';
      rows += '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05)">';
      rows += '<div style="display:flex;flex-direction:column;gap:2px"><span style="font-weight:600;color:#fff">' + formatCurrency(o.price) + '</span>' + buyer + '</div>';
      rows += '<span style="font-size:0.72rem;color:#8892b0">' + when + '</span>';
      rows += '</div>';
    });
    el.innerHTML = '<details style="margin-top:14px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:10px 14px">'
      + '<summary style="cursor:pointer;font-weight:600;color:#a29bfe;font-size:0.85rem;list-style:none"><i class="fas fa-list-ol"></i> Histórico de Lances (' + offers.length + ')</summary>'
      + '<div style="margin-top:8px">' + rows + '</div>'
      + '</details>';
  } catch (e) {
    el.innerHTML = '';
  }
}

function changeImage(url) {
  document.getElementById('main-image').src = url;
  document.querySelectorAll('.vehicle-thumbnails img').forEach(function(img) {
    img.classList.toggle('active', img.src === url);
  });
}

// Abre o anúncio do carro de um lance (a partir do painel). Se o veículo está
// no evento já carregado, abre o detalhe ao vivo (com lance/timer); senão, abre
// o anúncio a partir do snapshot salvo na hora do lance (read-only).
function openBidVehicle(adId, bidValue, status) {
  var live = currentVehicles.find(function(v) { return v.id === adId; });
  if (live) { openVehicle(adId); return; } // detalhe ao vivo já mostra o status do lance
  openSnapshotVehicle(adId, bidValue, status);
}

async function openSnapshotVehicle(adId, bidValue, status) {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('page-vehicle').classList.add('active');
  window.scrollTo(0, 0);
  document.getElementById('vehicle-detail').innerHTML = '<div class="empty-state" style="padding:40px"><i class="fas fa-spinner fa-spin"></i><p style="margin-top:8px;color:#8892b0">Carregando anúncio…</p></div>';
  try {
    var res = await fetch('/api/vehicle-history/' + adId);
    var data = await res.json();
    if (!data.success || !data.data) {
      document.getElementById('vehicle-detail').innerHTML = '<button class="btn-back-catalog" onclick="navigateTo(\'dashboard\')"><i class="fas fa-arrow-left"></i> Voltar ao Painel</button><div class="empty-state" style="padding:40px"><i class="fas fa-car"></i><h3>Anúncio indisponível</h3><p style="color:#8892b0">Não encontramos o registro deste veículo.</p></div>';
      return;
    }
    renderSnapshotDetail(data.data, bidValue, status);
  } catch (e) {
    document.getElementById('vehicle-detail').innerHTML = '<button class="btn-back-catalog" onclick="navigateTo(\'dashboard\')"><i class="fas fa-arrow-left"></i> Voltar ao Painel</button><div class="empty-state" style="padding:40px"><i class="fas fa-exclamation-triangle"></i><h3>Erro</h3><p style="color:#8892b0">' + esc(e.message) + '</p></div>';
  }
}

function renderSnapshotDetail(s, bidValue, status) {
  var photos = (s.photos || []).map(function(p) {
    return imgUrl(typeof p === 'string' ? p : (p.image || p.thumb || ''));
  }).filter(function(u) { return u; });
  var mainImg = photos.length > 0 ? photos[0] : '';

  var thumbs = '';
  photos.slice(0, 10).forEach(function(url, i) {
    thumbs += '<img src="' + esc(url) + '" onclick="changeImage(\'' + esc(url).replace(/'/g, "\\'") + '\')" class="' + (i === 0 ? 'active' : '') + '" loading="lazy">';
  });

  var title = (esc(s.brand || '') + ' ' + esc(s.model || '')).trim();
  var sub = esc(s.version || '');
  if (s.year_model) sub += ' — ' + esc(s.year_manufacture || '') + '/' + esc(s.year_model);

  var html = '<button class="btn-back-catalog" onclick="navigateTo(\'dashboard\')"><i class="fas fa-arrow-left"></i> Voltar ao Painel</button>';
  html += '<div class="vehicle-gallery" style="position:relative">';
  html += '<img id="main-image" src="' + esc(mainImg) + '" alt="' + title + '" data-index="0">';
  html += '<div class="vehicle-thumbnails">' + thumbs + '</div></div>';
  html += '<div class="vehicle-sidebar">';
  html += '<h2>' + title + '</h2>';
  html += '<div class="subtitle">' + sub + '</div>';
  if (bidValue && parseFloat(bidValue) > 0) {
    var stColor = status === 'ganhando' ? '#00b894' : (status === 'perdendo' ? '#ff7675' : '#fdcb6e');
    var stText = status === 'ganhando' ? '🏆 Ganhando' : (status === 'perdendo' ? '❌ Perdendo' : '⏳ Pendente');
    html += '<div style="background:rgba(108,92,231,0.12);border:1px solid rgba(108,92,231,0.3);border-radius:10px;padding:12px 14px;margin:12px 0">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">';
    html += '<div><div style="font-size:0.7rem;color:#8892b0;text-transform:uppercase;letter-spacing:0.5px">Seu lance</div><div style="font-size:1.15rem;font-weight:700;color:#fff">' + formatCurrency(bidValue) + '</div></div>';
    html += '<span style="color:' + stColor + ';font-weight:700;font-size:0.85rem;white-space:nowrap">' + stText + '</span>';
    html += '</div></div>';
  } else {
    html += '<div style="background:rgba(108,92,231,0.12);border:1px solid rgba(108,92,231,0.3);color:#a29bfe;padding:8px 12px;border-radius:8px;font-size:0.78rem;margin:12px 0"><i class="fas fa-clock-rotate-left"></i> Anúncio do veículo do seu lance.</div>';
  }
  if (s.fipe_value && parseFloat(s.fipe_value) > 0) {
    html += '<div class="bid-section"><div class="bid-row"><span class="label">FIPE' + (s.fipe_model ? ' (' + esc(s.fipe_model) + ')' : '') + '</span><span class="value highlight">' + formatCurrency(s.fipe_value) + '</span></div></div>';
  }
  html += '<div class="vehicle-specs">';
  html += '<div class="spec-row"><span class="label">Cor</span><span>' + esc(s.color || '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">Câmbio</span><span>' + esc(s.transmission || '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">Combustível</span><span>' + esc(s.fuel || '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">KM</span><span>' + (s.km ? Number(s.km).toLocaleString('pt-BR') : '-') + '</span></div>';
  html += '<div class="spec-row"><span class="label">Local</span><span>' + esc(s.location || s.uf || '-') + '</span></div>';
  html += '</div>';
  if (s.comitente) {
    html += '<div class="detail-comitente"><i class="fas fa-building"></i> ' + esc(s.comitente) + '</div>';
  }
  if (s.description) {
    html += '<div class="detail-description"><div class="detail-description-title"><i class="fas fa-clipboard-list"></i> Observações do veículo</div><div class="detail-description-body">' + esc(s.description).replace(/\n/g, '<br>') + '</div></div>';
  }
  html += '</div>';
  document.getElementById('vehicle-detail').innerHTML = html;
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
var lbZoom = { scale: 1, tx: 0, ty: 0 };
var lbBound = false;

function openLightbox() {
  if (!currentVehicle) return;
  lightboxImages = getVehicleImages(currentVehicle.vehicle);
  var mainImg = document.getElementById('main-image');
  lightboxIndex = parseInt(mainImg.getAttribute('data-index')) || 0;
  var overlay = document.getElementById('lightbox');
  lbRender(true);
  overlay.classList.add('active');
  if (!lbBound) { lbBindGestures(); lbBound = true; }
  // preload vizinhas pra não piscar no deslize
  lightboxImages.forEach(function(u){ (new Image()).src = u; });
}

function closeLightbox() {
  var overlay = document.getElementById('lightbox');
  overlay.classList.remove('active');
  overlay.style.background = '';
  lbResetZoom();
}

function lbResetZoom() { lbZoom.scale = 1; lbZoom.tx = 0; lbZoom.ty = 0; }

function lbApply(animate) {
  var img = document.getElementById('lightbox-img');
  if (!img) return;
  img.classList.toggle('animate', !!animate);
  img.style.transform = 'translate3d(' + lbZoom.tx + 'px,' + lbZoom.ty + 'px,0) scale(' + lbZoom.scale + ')';
}

function lbRender(resetZoom) {
  if (resetZoom) lbResetZoom();
  var total = lightboxImages.length;
  document.getElementById('lightbox-img').src = lightboxImages[lightboxIndex];
  document.getElementById('lightbox-counter').textContent = (lightboxIndex + 1) + ' / ' + total;
  lbApply(false);
}

var lbAnimating = false;

// Troca de foto com dissolução cruzada (crossfade): a nova imagem aparece
// por cima da atual com opacity 0→1 enquanto a atual some.
function lightboxNav(direction) {
  var total = lightboxImages.length;
  if (total < 2 || lbAnimating) return;
  lbAnimating = true;
  lbResetZoom();
  var img1 = document.getElementById('lightbox-img');
  var img2 = document.getElementById('lightbox-img2');

  lightboxIndex = (lightboxIndex + direction + total) % total;
  document.getElementById('lightbox-counter').textContent = (lightboxIndex + 1) + ' / ' + total;

  // img1 (atual) volta pra posição neutra antes do crossfade
  img1.classList.remove('animate');
  img1.style.transform = 'translate3d(0,0,0) scale(1)';

  // img2 = nova imagem, posicionada por cima, invisível
  img2.classList.remove('fade', 'animate');
  img2.style.transform = 'translate3d(0,0,0) scale(1)';
  img2.style.opacity = '0';
  img2.src = lightboxImages[lightboxIndex];
  void img2.offsetWidth;

  // crossfade: img1 some, img2 aparece
  img1.classList.add('fade');
  img2.classList.add('fade');
  img1.style.opacity = '0';
  img2.style.opacity = '1';

  setTimeout(function() {
    // consolida na img1 (primária/zoomável) e esconde a img2
    img1.classList.remove('fade');
    img1.src = lightboxImages[lightboxIndex];
    img1.style.transform = 'translate3d(0,0,0) scale(1)';
    img1.style.opacity = '1';
    img2.classList.remove('fade');
    img2.style.opacity = '0';
    lbAnimating = false;
  }, 330);
}

function lbBindGestures() {
  var overlay = document.getElementById('lightbox');
  var img = document.getElementById('lightbox-img');
  var start = null, lastTap = 0;
  function dist(t){ return Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY); }

  overlay.addEventListener('touchstart', function(e){
    if (e.touches.length === 2) {
      start = { mode:'pinch', d0:dist(e.touches), s0:lbZoom.scale };
    } else if (e.touches.length === 1) {
      var t = e.touches[0];
      start = { mode:'drag', x0:t.clientX, y0:t.clientY, tx0:lbZoom.tx, ty0:lbZoom.ty, s0:lbZoom.scale };
      var now = Date.now();
      if (now - lastTap < 280) {
        lbZoom.scale = lbZoom.scale > 1 ? 1 : 2.5; lbZoom.tx = 0; lbZoom.ty = 0;
        lbApply(true); start = null;
      }
      lastTap = now;
    }
  }, { passive:true });

  overlay.addEventListener('touchmove', function(e){
    if (!start) return;
    if (start.mode === 'pinch' && e.touches.length === 2) {
      e.preventDefault();
      lbZoom.scale = Math.min(5, Math.max(1, start.s0 * (dist(e.touches)/start.d0)));
      lbApply(false);
    } else if (start.mode === 'drag' && e.touches.length === 1) {
      var t = e.touches[0];
      var dx = t.clientX - start.x0, dy = t.clientY - start.y0;
      if (lbZoom.scale > 1) {
        e.preventDefault();
        lbZoom.tx = start.tx0 + dx; lbZoom.ty = start.ty0 + dy; lbApply(false);
      } else if (Math.abs(dy) > Math.abs(dx)) {
        e.preventDefault();
        lbZoom.ty = dy;
        var op = Math.max(0.2, 1 - Math.abs(dy)/500);
        overlay.style.background = 'rgba(0,0,0,' + (0.92*op) + ')';
        img.style.transform = 'translate3d(0,' + dy + 'px,0) scale(' + Math.max(0.85, 1-Math.abs(dy)/1600) + ')';
      } else {
        // swipe horizontal: sem deslizar a imagem; só um leve fade de feedback
        // (a troca real é por crossfade no touchend)
        lbZoom.tx = dx;
        img.classList.remove('fade');
        img.style.opacity = String(Math.max(0.55, 1 - Math.abs(dx)/500));
      }
    }
  }, { passive:false });

  overlay.addEventListener('touchend', function(e){
    if (!start) return;
    if (start.mode === 'drag' && start.s0 <= 1) {
      var dy = lbZoom.ty, dx = lbZoom.tx;
      overlay.style.background = '';
      if (Math.abs(dy) > 110 && Math.abs(dy) > Math.abs(dx)) { closeLightbox(); start=null; return; }
      if (Math.abs(dx) > 60 && Math.abs(dx) >= Math.abs(dy) && lightboxImages.length > 1) { lightboxNav(dx < 0 ? 1 : -1); start=null; return; }
      // volta: restaura opacidade e posição
      img.style.opacity = '1';
      lbZoom.tx = 0; lbZoom.ty = 0; lbApply(true);
    } else if (start.mode === 'pinch' && lbZoom.scale <= 1.02) {
      lbResetZoom(); lbApply(true);
    }
    start = null;
  }, { passive:true });

  // tap no fundo (fora da imagem) fecha
  overlay.addEventListener('click', function(e){ if (e.target === overlay) closeLightbox(); });
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
      myBids.add(advertisementId);
      localStorage.setItem('lp_mybids', JSON.stringify([...myBids]));
      updateMyBidValue(advertisementId, value); // Registrar valor do lance
      delete outbidNotified[advertisementId]; // Novo lance: zera dedupe de cobertura
      updateBidStatusBadge(advertisementId); // Atualizar badge visual
      updateDetailBidStatus(advertisementId); // Atualizar status na tela de detalhe
      showToast('🏆 Oferta enviada! Você está levando ' + name + ' por ' + formatCurrency(value), 'success', 8000);
      playSound('success');
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
      myBids.add(autoBidTargetId);
      localStorage.setItem('lp_mybids', JSON.stringify([...myBids]));
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

  var bidInput = document.getElementById('bid-value');
  if (!bidInput) {
    console.error('Elemento bid-value não encontrado');
    showToast('Erro interno: campo de oferta não encontrado', 'error');
    return;
  }

  var value = parseBidValue(bidInput.value);
  if (!value) return showToast('Informe o valor da oferta', 'error');

  // Buscar veículo de currentVehicle ou currentVehicles
  var v = currentVehicle;
  if (!v) {
    v = currentVehicles.find(function(x) { return x.id === advertisementId; });
  }

  var name = v ? esc(v.vehicle.brand_name) + ' ' + esc(v.vehicle.model_name) : 'Veículo';

  var ok = await showConfirm('Confirmar Oferta', 'Deseja enviar esta oferta?', '<div class="confirm-value">' + formatCurrency(value) + '</div><div class="confirm-vehicle">' + name + '</div>');
  if (!ok) return;

  try {
    var snapshot = buildVehicleSnapshot(v);
    var res = await api.placeBid(advertisementId, value, v ? v.vehicle.brand_name : '', v ? v.vehicle.model_name : '', snapshot);
    if (res.success) {
      myBids.add(advertisementId);
      localStorage.setItem('lp_mybids', JSON.stringify([...myBids]));
      updateMyBidValue(advertisementId, value); // Registrar valor do lance
      delete outbidNotified[advertisementId]; // Novo lance: zera dedupe de cobertura
      updateBidStatusBadge(advertisementId); // Atualizar badge visual
      updateDetailBidStatus(advertisementId); // Atualizar status na tela de detalhe
      showToast('🏆 Oferta enviada! Você está levando ' + name + ' por ' + formatCurrency(value), 'success', 8000);
      playSound('success');

      // Atualizar o input com o próximo valor mínimo
      if (v && v.negotiation) {
        var newMin = value + v.negotiation.increment;
        bidInput.value = formatBidValue(newMin);
      }
    } else {
      showToast(res.error || 'Não foi possível enviar a oferta', 'error');
    }
  } catch (err) {
    showToast('Erro ao enviar oferta: ' + err.message, 'error');
  }
}

async function submitBuyNow(advertisementId, value) {
  if (!requireLogin()) return;

  // Buscar veículo de currentVehicle ou currentVehicles
  var v = currentVehicle;
  if (!v) {
    v = currentVehicles.find(function(x) { return x.id === advertisementId; });
  }

  var name = v ? esc(v.vehicle.brand_name) + ' ' + esc(v.vehicle.model_name) : 'Veículo';

  var ok = await showConfirm('Compra Imediata', 'Confirma a compra imediata?', '<div class="confirm-value">' + formatCurrency(value) + '</div><div class="confirm-vehicle">' + name + '</div>');
  if (!ok) return;

  try {
    var snapshot = buildVehicleSnapshot(v);
    var res = await api.buyNow(advertisementId, value, snapshot);
    if (res.success) {
      showToast('Compra realizada com sucesso!', 'success');
      playSound('success');
      // Win confirmado: abre o pagamento do sinal (10%) imediatamente.
      var rawName = v ? (v.vehicle.brand_name + ' ' + v.vehicle.model_name) : 'Veículo';
      openPixPayment({ valor: Math.round(value * 0.10 * 100) / 100, advertisementId: advertisementId, vehicleName: rawName, tipo: 'sinal' });
      // Recarregar veículos para atualizar status
      var savedEvent = localStorage.getItem('lp_event');
      if (savedEvent) loadVehicles(savedEvent);
    } else {
      showToast(res.error || 'Não foi possível realizar a compra', 'error');
    }
  } catch (err) {
    showToast('Erro: ' + err.message, 'error');
  }
}

// ===== Tela de pagamento do sinal (PIX) =====
// Sinal = 10% pago em até 5 min após a vitória. Mostra copia-e-cola + QR + countdown
// e confirma sozinho (polling do status; o webhook do gateway marca como pago).
var PIX_PRAZO_SEGUNDOS = 5 * 60;
var pixCountdownInterval = null;
var pixPollInterval = null;

function closePixPayment() {
  var modal = document.getElementById('modal-pix');
  if (modal) modal.style.display = 'none';
  if (pixCountdownInterval) { clearInterval(pixCountdownInterval); pixCountdownInterval = null; }
  if (pixPollInterval) { clearInterval(pixPollInterval); pixPollInterval = null; }
}

function pixFallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}

// opts: { valor, advertisementId, vehicleName, tipo }
async function openPixPayment(opts) {
  opts = opts || {};
  if (!requireLogin()) return;
  var modal = document.getElementById('modal-pix');
  var body = document.getElementById('pix-body');
  if (!modal || !body) return;
  modal.style.display = 'flex';
  body.innerHTML = '<div class="pix-loading"><i class="fas fa-spinner fa-spin"></i> Gerando seu PIX...</div>';

  var valor = Math.round((opts.valor || 0) * 100) / 100;
  var res;
  try {
    res = await api.generatePix(valor, opts.advertisementId, opts.vehicleName || '', opts.tipo || 'sinal');
  } catch (err) {
    body.innerHTML = '<div class="pix-error"><i class="fas fa-triangle-exclamation"></i> Erro ao gerar o PIX. Tente novamente.</div>';
    return;
  }
  if (!res || !res.success || !res.data || !res.data.pixCopiaCola) {
    body.innerHTML = '<div class="pix-error"><i class="fas fa-triangle-exclamation"></i> ' + esc((res && res.error) || 'Não foi possível gerar o PIX agora.') + '</div>';
    return;
  }

  var copiaCola = res.data.pixCopiaCola;
  var txid = res.data.txid;

  body.innerHTML =
    '<div class="pix-header"><i class="fas fa-bolt"></i><h3>Pague o sinal para garantir</h3></div>' +
    (opts.vehicleName ? '<div class="pix-vehicle">' + esc(opts.vehicleName) + '</div>' : '') +
    '<div class="pix-amount">' + formatCurrency(valor) + '<span>sinal de 10%</span></div>' +
    '<div class="pix-timer" id="pix-timer">05:00</div>' +
    '<div class="pix-timer-label">Pague dentro do prazo para não perder a reserva</div>' +
    '<div class="pix-qr" id="pix-qr"></div>' +
    '<div class="pix-copia-label">PIX copia e cola</div>' +
    '<div class="pix-copia"><span id="pix-copia-text"></span></div>' +
    '<button class="btn btn-primary pix-copy-btn" id="pix-copy-btn"><i class="fas fa-copy"></i> Copiar código PIX</button>' +
    '<div class="pix-hint">Abra o app do seu banco, escolha PIX e cole o código (ou escaneie o QR). A confirmação aqui é automática.</div>';

  document.getElementById('pix-copia-text').textContent = copiaCola;

  // QR gerado no próprio navegador — o código não sai do dispositivo.
  try {
    if (window.QRCode) {
      new QRCode(document.getElementById('pix-qr'), { text: copiaCola, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
    } else {
      document.getElementById('pix-qr').style.display = 'none';
    }
  } catch (e) {
    var qrEl = document.getElementById('pix-qr');
    if (qrEl) qrEl.style.display = 'none';
  }

  document.getElementById('pix-copy-btn').addEventListener('click', function() {
    var ok = function() { showToast('Código PIX copiado!', 'success'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(copiaCola).then(ok).catch(function() { pixFallbackCopy(copiaCola); ok(); });
    } else { pixFallbackCopy(copiaCola); ok(); }
  });

  var restante = PIX_PRAZO_SEGUNDOS;
  var timerEl = document.getElementById('pix-timer');
  if (pixCountdownInterval) clearInterval(pixCountdownInterval);
  pixCountdownInterval = setInterval(function() {
    restante--;
    if (restante <= 0) {
      clearInterval(pixCountdownInterval); pixCountdownInterval = null;
      if (pixPollInterval) { clearInterval(pixPollInterval); pixPollInterval = null; }
      pixExpired();
      return;
    }
    var m = Math.floor(restante / 60), s = restante % 60;
    if (timerEl) {
      timerEl.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
      if (restante <= 60) timerEl.classList.add('urgent');
    }
  }, 1000);

  if (pixPollInterval) clearInterval(pixPollInterval);
  pixPollInterval = setInterval(async function() {
    try {
      var st = await api.getPixStatus(txid);
      if (st && st.success && st.data && st.data.paid) {
        clearInterval(pixPollInterval); pixPollInterval = null;
        if (pixCountdownInterval) { clearInterval(pixCountdownInterval); pixCountdownInterval = null; }
        pixConfirmed();
      }
    } catch (e) { /* ignora falha pontual de polling */ }
  }, 4000);
}

function pixConfirmed() {
  playSound('success');
  var body = document.getElementById('pix-body');
  if (body) body.innerHTML = '<div class="pix-result success"><i class="fas fa-circle-check"></i><h3>Pagamento confirmado!</h3><p>Sua reserva está garantida. Em breve falamos sobre as próximas etapas.</p><button class="btn btn-primary" onclick="closePixPayment()" style="width:100%">Fechar</button></div>';
}

function pixExpired() {
  var body = document.getElementById('pix-body');
  if (body) body.innerHTML = '<div class="pix-result expired"><i class="fas fa-clock"></i><h3>Prazo expirado</h3><p>O tempo para o pagamento do sinal acabou. Se ainda tiver interesse, fale com a gente.</p><button class="btn btn-glass" onclick="closePixPayment()" style="width:100%">Fechar</button></div>';
}

// ===== Modo teste: card de veículo fake pra testar o pagamento sem comprar de verdade =====
// Ativa SÓ com ?test=1 na URL. Nunca aparece pro cliente normal e não toca no fluxo real
// (não entra em currentVehicles, polling, websocket ou filtros — é só um card visual extra).
function isTestMode() {
  // Desativado até segunda ordem (esconde o card "Veículo de Teste").
  // Para reativar, troque por: return /[?&]test=1(?:&|$)/.test(window.location.search);
  return false;
}

function testCardHtml() {
  return '<div class="vehicle-card test-card">' +
    '<div class="vehicle-card-img-wrap" style="display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(201,169,110,0.18),rgba(0,206,201,0.12))">' +
      '<i class="fas fa-flask" style="font-size:2.6rem;color:var(--primary)"></i>' +
      '<div class="vehicle-card-badges"><span class="badge" style="background:#6c5ce7;color:#fff">TESTE</span></div>' +
    '</div>' +
    '<div class="vehicle-card-body">' +
      '<div class="vehicle-card-header"><div class="vehicle-card-title">Veículo de Teste</div></div>' +
      '<div class="vehicle-card-subtitle">Gera um PIX real de R$ 1,00 para você testar o pagamento do sinal sem comprar de verdade.</div>' +
      '<button class="btn btn-primary" style="width:100%;margin-top:14px" onclick="testPixPayment()"><i class="fas fa-bolt"></i> Testar pagamento do sinal</button>' +
    '</div>' +
  '</div>';
}

function testPixPayment() {
  openPixPayment({ valor: 1.00, advertisementId: null, vehicleName: 'VEÍCULO DE TESTE (não é uma compra real)', tipo: 'teste' });
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
    if (sort === 'available-only') {
      var end = new Date(v.negotiation.finish_date_offer);
      if (end <= new Date()) return false;
    }
    return true;
  });

  switch (sort) {
    case 'available-only':
    case 'time':
      filtered.sort(function(a, b) { return new Date(a.negotiation.finish_date_offer) - new Date(b.negotiation.finish_date_offer); });
      break;
    case 'price-asc':
      filtered.sort(function(a, b) { return (a.offer_actual ? a.offer_actual.price : a.negotiation.value_actual) - (b.offer_actual ? b.offer_actual.price : b.negotiation.value_actual); });
      break;
    case 'price-desc':
      filtered.sort(function(a, b) { return (b.offer_actual ? b.offer_actual.price : b.negotiation.value_actual) - (a.offer_actual ? a.offer_actual.price : a.negotiation.value_actual); });
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

document.getElementById('event-tabs').addEventListener('click', function(e) {
  var tab = e.target.closest('.event-tab');
  if (!tab) return;
  var eventId = tab.getAttribute('data-event-id');
  if (!eventId) return;
  document.querySelectorAll('#event-tabs .event-tab.active').forEach(function(t) { t.classList.remove('active'); });
  tab.classList.add('active');
  var select = document.getElementById('filter-event');
  if (select && select.value !== eventId) {
    select.value = eventId;
    select.dispatchEvent(new Event('change'));
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
          dHtml += '<div class="dash-offer-item" onclick="openBidVehicle(' + b.advertisement_id + ',' + (valor || 0) + ',\'' + (b.status || '') + '\')" style="border-left:3px solid '+borderColor+';padding-left:12px;cursor:pointer">';
          dHtml += '<div class="dash-offer-info">';
          dHtml += '<strong>' + vehicle + ' <i class="fas fa-chevron-right" style="font-size:0.7rem;color:#8892b0;margin-left:4px"></i></strong>';
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

// === MINHA CONTA (perfil do cliente) ===
async function loadProfile() {
  var el = document.getElementById('profile-content');
  var token = localStorage.getItem('lp_token');
  if (!el) return;
  if (!token) {
    el.innerHTML = '<div class="empty-state" style="padding:50px"><i class="fas fa-user-lock"></i><h3>Faça login</h3><p style="color:#8892b0">Entre na sua conta para ver seu perfil.</p><button class="btn btn-primary" style="margin-top:14px" onclick="openModal()">Entrar / Cadastrar</button></div>';
    return;
  }
  el.innerHTML = '<div class="empty-state" style="padding:50px"><i class="fas fa-spinner fa-spin"></i><p style="margin-top:8px;color:#8892b0">Carregando seu perfil…</p></div>';
  try {
    var res = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
    var data = await res.json();
    if (!data.success) { el.innerHTML = '<div class="empty-state" style="padding:50px"><i class="fas fa-user-lock"></i><h3>Sessão expirada</h3><button class="btn btn-primary" style="margin-top:14px" onclick="openModal()">Entrar novamente</button></div>'; return; }
    renderProfile(data.user);
    loadProfileDocs();
  } catch (e) {
    el.innerHTML = '<div class="empty-state" style="padding:50px"><i class="fas fa-exclamation-triangle"></i><h3>Erro</h3><p style="color:#8892b0">' + esc(e.message) + '</p></div>';
  }
}

function pInput(id, label, value, type, attrs) {
  return '<div class="form-group"><label>' + label + '</label><input class="form-input" id="' + id + '" type="' + (type || 'text') + '" value="' + esc(value == null ? '' : String(value)) + '" ' + (attrs || '') + '></div>';
}

function renderProfile(u) {
  var status = u.approved
    ? '<span class="badge badge-laudo-ok"><i class="fas fa-check-circle"></i> Conta aprovada</span>'
    : '<span class="badge badge-laudo-warn"><i class="fas fa-clock"></i> Em análise</span>';
  var pj = u.person_type === 'juridica';
  var html = '';
  html += '<div class="section-header" style="text-align:left;margin:0 0 8px"><h2><i class="fas fa-user-circle" style="color:var(--primary)"></i> Minha Conta</h2></div>';
  html += '<div style="margin-bottom:20px">' + status + '<span style="color:#8892b0;font-size:0.8rem;margin-left:10px">Cadastro: ' + (u.created_at ? new Date(u.created_at).toLocaleDateString('pt-BR') : '-') + '</span></div>';

  // Dados
  html += '<div class="profile-card"><h3 class="profile-card-title"><i class="fas fa-id-card"></i> Dados</h3>';
  html += pInput('pf-name', 'Nome completo', u.name);
  html += '<div class="form-group"><label>E-mail (login)</label><input class="form-input" value="' + esc(u.email || '') + '" disabled style="opacity:.6"></div>';
  html += pInput('pf-phone', 'Telefone', u.phone, 'tel');
  html += '<div class="form-group"><label>Tipo de pessoa</label><select class="form-input" id="pf-person" onchange="togglePersonType()"><option value="fisica"' + (!pj ? ' selected' : '') + '>Pessoa Física</option><option value="juridica"' + (pj ? ' selected' : '') + '>Pessoa Jurídica</option></select></div>';
  html += '<div id="pf-fisica" style="display:' + (pj ? 'none' : 'block') + '">' + pInput('pf-cpf', 'CPF', u.cpf) + pInput('pf-birth', 'Data de nascimento', (u.birth_date || '').slice(0, 10), 'date') + '</div>';
  html += '<div id="pf-juridica" style="display:' + (pj ? 'block' : 'none') + '">' + pInput('pf-cnpj', 'CNPJ', u.cnpj) + pInput('pf-company', 'Razão social', u.company_name) + '</div>';
  html += '</div>';

  // Endereço
  html += '<div class="profile-card"><h3 class="profile-card-title"><i class="fas fa-location-dot"></i> Endereço</h3>';
  html += pInput('pf-cep', 'CEP', u.cep, 'text', 'onblur="lookupCep()"');
  html += pInput('pf-street', 'Rua', u.street);
  html += '<div style="display:flex;gap:10px"><div style="flex:1">' + pInput('pf-number', 'Número', u.number) + '</div><div style="flex:2">' + pInput('pf-complement', 'Complemento', u.complement) + '</div></div>';
  html += pInput('pf-neighborhood', 'Bairro', u.neighborhood);
  html += '<div style="display:flex;gap:10px"><div style="flex:2">' + pInput('pf-city', 'Cidade', u.city) + '</div><div style="flex:1">' + pInput('pf-uf', 'UF', u.uf, 'text', 'maxlength="2"') + '</div></div>';
  html += '</div>';

  html += '<div style="margin:4px 0 26px"><button class="btn btn-primary btn-lg" onclick="saveProfile()"><i class="fas fa-floppy-disk"></i> Salvar alterações</button> <span id="pf-status" style="margin-left:10px;font-size:0.85rem"></span></div>';

  // Senha
  html += '<div class="profile-card"><h3 class="profile-card-title"><i class="fas fa-lock"></i> Trocar senha</h3>';
  html += pInput('pf-pass-cur', 'Senha atual', '', 'password');
  html += pInput('pf-pass-new', 'Nova senha (mín. 6)', '', 'password');
  html += '<button class="btn btn-glass" onclick="changeMyPassword()"><i class="fas fa-key"></i> Atualizar senha</button> <span id="pf-pass-status" style="margin-left:10px;font-size:0.85rem"></span>';
  html += '</div>';

  // Documentos
  html += '<div class="profile-card"><h3 class="profile-card-title"><i class="fas fa-file-arrow-up"></i> Documentos</h3>';
  html += '<p style="color:#8892b0;font-size:0.82rem;margin-bottom:12px">Envie RG/CNH e comprovante de endereço (foto ou PDF, até 5MB).</p>';
  html += '<div id="pf-docs">Carregando…</div>';
  html += '<label class="btn btn-glass" style="margin-top:12px;display:inline-block;cursor:pointer"><i class="fas fa-plus"></i> Adicionar documento<input type="file" accept="image/*,application/pdf" style="display:none" onchange="uploadDoc(this)"></label> <span id="pf-doc-status" style="margin-left:10px;font-size:0.85rem"></span>';
  html += '</div>';

  document.getElementById('profile-content').innerHTML = html;
}

function togglePersonType() {
  var pj = document.getElementById('pf-person').value === 'juridica';
  document.getElementById('pf-fisica').style.display = pj ? 'none' : 'block';
  document.getElementById('pf-juridica').style.display = pj ? 'block' : 'none';
}

async function lookupCep() {
  var cep = (document.getElementById('pf-cep').value || '').replace(/\D/g, '');
  if (cep.length !== 8) return;
  try {
    var r = await fetch('https://viacep.com.br/ws/' + cep + '/json/');
    var d = await r.json();
    if (d.erro) return;
    if (!document.getElementById('pf-street').value) document.getElementById('pf-street').value = d.logradouro || '';
    if (!document.getElementById('pf-neighborhood').value) document.getElementById('pf-neighborhood').value = d.bairro || '';
    if (!document.getElementById('pf-city').value) document.getElementById('pf-city').value = d.localidade || '';
    if (!document.getElementById('pf-uf').value) document.getElementById('pf-uf').value = d.uf || '';
  } catch (e) {}
}

async function saveProfile() {
  var st = document.getElementById('pf-status');
  st.style.color = '#fdcb6e'; st.textContent = 'Salvando…';
  var body = {
    name: val('pf-name'), phone: val('pf-phone'), person_type: val('pf-person'),
    cpf: val('pf-cpf'), birth_date: val('pf-birth'), cnpj: val('pf-cnpj'), company_name: val('pf-company'),
    cep: val('pf-cep'), street: val('pf-street'), number: val('pf-number'), complement: val('pf-complement'),
    neighborhood: val('pf-neighborhood'), city: val('pf-city'), uf: val('pf-uf')
  };
  try {
    var res = await fetch('/api/auth/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('lp_token') }, body: JSON.stringify(body) });
    var data = await res.json();
    if (data.success) { st.style.color = '#00b894'; st.textContent = '✓ Salvo'; }
    else { st.style.color = '#ff7675'; st.textContent = data.error || 'Erro'; }
  } catch (e) { st.style.color = '#ff7675'; st.textContent = 'Erro de conexão'; }
}

function val(id) { var e = document.getElementById(id); return e ? e.value : ''; }

async function changeMyPassword() {
  var st = document.getElementById('pf-pass-status');
  st.style.color = '#fdcb6e'; st.textContent = 'Atualizando…';
  try {
    var res = await fetch('/api/auth/me/password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('lp_token') }, body: JSON.stringify({ current: val('pf-pass-cur'), newPassword: val('pf-pass-new') }) });
    var data = await res.json();
    if (data.success) { st.style.color = '#00b894'; st.textContent = '✓ Senha atualizada'; document.getElementById('pf-pass-cur').value = ''; document.getElementById('pf-pass-new').value = ''; }
    else { st.style.color = '#ff7675'; st.textContent = data.error || 'Erro'; }
  } catch (e) { st.style.color = '#ff7675'; st.textContent = 'Erro de conexão'; }
}

async function loadProfileDocs() {
  var box = document.getElementById('pf-docs');
  if (!box) return;
  try {
    var res = await fetch('/api/auth/me/documents', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('lp_token') } });
    var data = await res.json();
    var docs = (data.success && data.data) ? data.data : [];
    if (!docs.length) { box.innerHTML = '<p style="color:#8892b0;font-size:0.82rem">Nenhum documento enviado.</p>'; return; }
    var html = '';
    docs.forEach(function(d) {
      html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05)">';
      html += '<span style="font-size:0.85rem"><i class="fas fa-file" style="color:var(--primary);margin-right:6px"></i>' + esc(d.filename || 'documento') + '</span>';
      html += '<span style="display:flex;gap:8px"><button class="btn btn-glass" style="padding:4px 10px;font-size:0.75rem" onclick="viewDoc(' + d.id + ')">Ver</button><button class="btn btn-glass" style="padding:4px 10px;font-size:0.75rem;color:#ff7675" onclick="deleteDoc(' + d.id + ')">Excluir</button></span>';
      html += '</div>';
    });
    box.innerHTML = html;
  } catch (e) { box.innerHTML = '<p style="color:#ff7675;font-size:0.82rem">Erro ao carregar documentos.</p>'; }
}

async function viewDoc(id) {
  try {
    var res = await fetch('/api/auth/me/documents/' + id, { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('lp_token') } });
    var blob = await res.blob();
    window.open(URL.createObjectURL(blob), '_blank');
  } catch (e) {}
}

async function deleteDoc(id) {
  if (!confirm('Excluir este documento?')) return;
  await fetch('/api/auth/me/documents/' + id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + localStorage.getItem('lp_token') } });
  loadProfileDocs();
}

function uploadDoc(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var st = document.getElementById('pf-doc-status');
  st.style.color = '#fdcb6e'; st.textContent = 'Enviando…';
  var send = function(base64, mime) {
    fetch('/api/auth/me/documents', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('lp_token') }, body: JSON.stringify({ doc_type: 'documento', filename: file.name, mime: mime, data: base64 }) })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) { st.style.color = '#00b894'; st.textContent = '✓ Enviado'; loadProfileDocs(); }
        else { st.style.color = '#ff7675'; st.textContent = d.error || 'Erro'; }
      })
      .catch(function() { st.style.color = '#ff7675'; st.textContent = 'Erro de conexão'; });
    input.value = '';
  };
  if (file.type.indexOf('image/') === 0) {
    // Comprime imagem (canvas) pra reduzir o tamanho do upload
    var reader = new FileReader();
    reader.onload = function(ev) {
      var img = new Image();
      img.onload = function() {
        var max = 1280, w = img.width, h = img.height;
        if (w > max || h > max) { if (w > h) { h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; } }
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        send(c.toDataURL('image/jpeg', 0.8), 'image/jpeg');
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  } else {
    var reader2 = new FileReader();
    reader2.onload = function(ev) { send(ev.target.result, file.type || 'application/octet-stream'); };
    reader2.readAsDataURL(file);
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
  initPromoBanner();
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
  loadFeaturedVehicles();
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

// Abre o laudo cautelar com tela de "preparando" enquanto o servidor redige
// (remove o nome da Dealers). A 1ª vez de cada laudo pode levar alguns segundos
// (OCR); depois é instantâneo (cache do servidor). Abrimos a aba já no clique
// pra não cair no bloqueador de pop-up, e trocamos pro PDF quando fica pronto.
function openLaudo(encodedUrl) {
  var proxyUrl = '/api/laudo-proxy?url=' + encodedUrl;
  var win = window.open('', '_blank');
  if (!win) {
    // Pop-up bloqueado: navega direto (sem tela de loading)
    window.location.href = proxyUrl;
    return;
  }
  win.document.write(
    '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Preparando laudo...</title>' +
    '<style>body{margin:0;height:100vh;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;font-family:-apple-system,Segoe UI,Roboto,sans-serif;' +
    'background:#0b0d17;color:#e8eaf0}.sp{width:48px;height:48px;border:4px solid rgba(108,92,231,.25);' +
    'border-top-color:#6c5ce7;border-radius:50%;animation:r 1s linear infinite;margin-bottom:20px}' +
    '@keyframes r{to{transform:rotate(360deg)}}h2{font-weight:600;margin:0 0 8px}p{color:#8892b0;margin:0;font-size:.9rem;text-align:center;padding:0 24px}</style>' +
    '</head><body><div class="sp"></div><h2>Preparando laudo cautelar</h2>' +
    '<p>Isso leva alguns segundos na primeira vez. Aguarde…</p></body></html>'
  );
  win.document.close();

  fetch(proxyUrl)
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    })
    .then(function(blob) {
      var blobUrl = URL.createObjectURL(blob);
      try { win.location.href = blobUrl; }
      catch (e) { window.location.href = blobUrl; }
    })
    .catch(function(e) {
      try {
        win.document.body.innerHTML =
          '<div style="text-align:center;padding:24px;font-family:sans-serif;color:#e8eaf0">' +
          '<p>Não consegui carregar o laudo agora.</p>' +
          '<p><a style="color:#a29bfe" href="' + proxyUrl + '">Tentar abrir direto</a></p></div>';
      } catch (_) {}
    });
}
