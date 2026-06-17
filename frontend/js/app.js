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

// Extrai quem está liderando a oferta a partir dos dados do veículo.
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
      var who = coverer && coverer.shop ? ' — coberto por outra loja' : '';
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
    if (msg.type === 'bid_update') {
      handleBidUpdate(msg.advertisement_id, msg.data);
      // Avisa listeners externos (Meu Painel, admin) que rolou novo lance.
      // Usado pra acionar refresh imediato em telas que dependem do estado.
      document.dispatchEvent(new CustomEvent('lp:bid-update', { detail: { advertisement_id: msg.advertisement_id, data: msg.data } }));
    }
  };
  ws.onclose = function() { setTimeout(connectWebSocket, 3000); };
}

function handleBidUpdate(adId, data) {
  const idx = currentVehicles.findIndex(function(v) { return v.id === adId; });
  if (idx === -1 || !data) return;
  var vehicle = currentVehicles[idx];
  var oldPrice = vehicle.offer_actual ? vehicle.offer_actual.price : vehicle.negotiation.value_actual;
  if (data.value_actual) currentVehicles[idx].negotiation.value_actual = data.value_actual;
  if (data.offers != null) currentVehicles[idx].offers = data.offers;
  if (data.offer_actual) currentVehicles[idx].offer_actual = data.offer_actual;
  // Tempo: o lance estende o relógio. Aceita os vários formatos da origem.
  if (data.finish_date_offer) currentVehicles[idx].negotiation.finish_date_offer = data.finish_date_offer;
  if (data.finish_date) currentVehicles[idx].negotiation.finish_date_offer = data.finish_date;
  if (data.negotiation && data.negotiation.finish_date_offer) currentVehicles[idx].negotiation.finish_date_offer = data.negotiation.finish_date_offer;
  var newPrice = data.value_actual || (data.offer_actual ? data.offer_actual.price : oldPrice);

  // Verificar se EU tinha um lance neste veículo e se foi coberto
  if (newPrice > oldPrice && myBids.has(adId)) {
    handleOutbid(adId, newPrice, currentVehicles[idx]);
  } else if (newPrice > oldPrice) {
    playSound('bid'); // som discreto de lance
  }

  // Atualiza o card NO LUGAR (instantâneo). Antes isso fazia renderVehicles() na
  // lista inteira — pesado e resetava a rolagem. Agora preço/ofertas/tempo entram
  // na hora e o ticker de 1s cuida do escurecer/AO VIVO a partir do novo data-end.
  var nv = currentVehicles[idx];
  var dispPrice = nv.offer_actual ? nv.offer_actual.price : nv.negotiation.value_actual;
  var priceEl = document.getElementById('price-' + adId);
  if (priceEl) priceEl.textContent = formatCurrency(dispPrice);
  var inputEl = document.getElementById('card-bid-' + adId);
  if (inputEl && document.activeElement !== inputEl) inputEl.value = formatBidValue(dispPrice + nv.negotiation.increment);
  var offEl = document.getElementById('offers-' + adId);
  if (offEl && nv.offers != null) {
    var on = nv.offers || 0;
    offEl.textContent = on + ' oferta' + (on > 1 ? 's' : '');
    offEl.style.display = on > 0 ? '' : 'none';
  }
  var card = document.querySelector('[data-vehicle-id="' + adId + '"]');
  if (card) {
    var tb = card.querySelector('.timer-badge[data-end]');
    if (tb && nv.negotiation.finish_date_offer) tb.setAttribute('data-end', nv.negotiation.finish_date_offer);
  }

  updateFipeBadge(adId, newPrice);
  updateBidStatusBadge(adId);

  if (currentVehicle && currentVehicle.id === adId) {
    currentVehicle = currentVehicles[idx];
    renderVehicleDetail(currentVehicle);
  }

  // O evento do WebSocket da origem nem sempre vem com o finish_date_offer
  // novo — às vezes ele só carrega o preço. Sem isso, o cronômetro só estende
  // no próximo poll (até 3s depois). Por isso disparamos um poll-relâmpago
  // logo após o lance: pega o tempo novo em ~300ms. Debounced pra não floodar
  // se cair uma chuva de lances.
  scheduleQuickPoll();
}

var _quickPollTimer = null;
function scheduleQuickPoll() {
  if (_quickPollTimer) return; // já tem um na fila
  _quickPollTimer = setTimeout(function() {
    _quickPollTimer = null;
    var ev = parseInt(localStorage.getItem('lp_event'));
    if (ev) pollVehicles(ev);
  }, 300);
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
    var who = cov && cov.shop ? ' por outra loja' : '';
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
  // Limpa o contexto de "evento em breve" ao sair da catálogo (e do detalhe,
  // que herda o cronômetro dela), pra não vazar o "Em XhYmin" pra outras telas.
  if (page !== 'catalog' && page !== 'vehicle') window.catalogEventStartMs = 0;
  // Vitrine usa identidade visual SEPARADA — esconde navbar/ticker do LancePrime
  document.body.classList.toggle('is-showroom', page === 'showroom');
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.nav-link').forEach(function(l) { l.classList.remove('active'); });
  document.getElementById('page-' + page).classList.add('active');
  var navLink = document.querySelector('[data-page="' + page + '"]');
  if (navLink) navLink.classList.add('active');
  if (page === 'catalog') loadEvents();
  if (page === 'showroom') loadShowroom();
  if (page === 'dashboard') { loadDashboard(); startDashboardAutoRefresh(); } else { stopDashboardAutoRefresh(); }
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

// Time offset to sync with the source timer (ms)
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

function formatTimer(endDate, startDate) {
  if (!endDate) return { text: 'Aguardando', active: false };
  var now = new Date(Date.now() + serverTimeOffset);

  // start_date_offer é a fonte da verdade por LOTE. Se vier preenchido e estiver
  // no PASSADO, o lote já abriu pra lance há tempos — mostramos countdown
  // ESCALONADO até o finish_date_offer de cada lote (Ka 7m10s, Renegade 7m40s,
  // Mobi 8m10s, igual a Dealers).
  // Se vier preenchido e estiver no FUTURO, ainda não abriu — countdown ao
  // start_date_offer. Sem start_date_offer (eventos antigos), caímos no
  // catalogEventStartMs do evento todo (comportamento legado).
  var upcomingTargetMs = null;
  if (startDate) {
    var sd = new Date(startDate).getTime();
    if (!isNaN(sd) && now.getTime() < sd) upcomingTargetMs = sd;
    // se startDate no passado: NAO usar catalogEventStartMs — lote já está open
  } else if (window.catalogEventStartMs && now.getTime() < window.catalogEventStartMs) {
    upcomingTargetMs = window.catalogEventStartMs;
  }
  if (upcomingTargetMs) {
    var diffStart = upcomingTargetMs - now.getTime();
    var dd = Math.floor(diffStart / (1000 * 60 * 60 * 24));
    var hh = Math.floor((diffStart % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    var mm = Math.floor((diffStart % (1000 * 60 * 60)) / (1000 * 60));
    var ss = Math.floor((diffStart % (1000 * 60)) / 1000);
    var t = '';
    if (dd > 0) t += dd + 'd ';
    t += String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    return { text: t, active: false, upcoming: true };
  }

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
  // O backend já entrega a URL final no esquema /api/img/<id> (ID opaco) que
  // não revela a origem. Aqui é só passagem (sem mais regex de domínio).
  return rawUrl || '';
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
  // O servidor já entrega o nome limpo; aqui só normaliza espaços.
  return (name || '').replace(/\s+/g, ' ').trim();
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

// O evento NÃO tem hora fixa de fim: acaba quando os lotes (carros) fecham.
// Marcamos como encerrado quando nenhum carro está mais em disputa, e guardamos
// o horário do fim REAL (último lote a fechar). 3h depois desse fim, escondemos
// a aba. Os carros já têm o cronômetro espelhado da origem.
window.eventEnded = window.eventEnded || {};
window.eventRealEndMs = window.eventRealEndMs || {};
var EVENT_KEEP_AFTER_END_MS = 3 * 60 * 60 * 1000; // mantém 3h como ENCERRADO

function markEventEnded(eventId, vehicles) {
  if (eventId == null) return;
  var id = String(eventId);
  var nowMs = Date.now() + serverTimeOffset;

  if (!vehicles || vehicles.length === 0) {
    // Sem carros = encerrado. Se ainda não sabíamos o fim, usa agora como referência.
    window.eventEnded[id] = true;
    if (window.eventRealEndMs[id] == null) window.eventRealEndMs[id] = nowMs;
    return;
  }

  var maxFinish = 0;
  var anyOpen = false;
  vehicles.forEach(function(v) {
    var neg = v && v.negotiation;
    var fo = neg && neg.finish_date_offer;
    if (fo) {
      var t = new Date(fo).getTime();
      if (!isNaN(t)) {
        if (t > maxFinish) maxFinish = t;
        if (t > nowMs) anyOpen = true;
      }
    }
  });

  window.eventEnded[id] = !anyOpen;
  if (anyOpen) {
    delete window.eventRealEndMs[id]; // voltou a ter carro aberto
  } else if (maxFinish > 0) {
    window.eventRealEndMs[id] = maxFinish; // fim real = último lote a fechar
  }
}

// Esconde a aba do evento 3h depois do fim REAL (quando os lotes fecharam).
function eventShouldHide(eventId) {
  var end = window.eventRealEndMs[String(eventId)];
  if (end == null) return false;
  return (Date.now() + serverTimeOffset) > end + EVENT_KEEP_AFTER_END_MS;
}

// Estado do evento considerando os lotes: se os carros já fecharam, força
// ENCERRADO mesmo que o horário "oficial" (finish_date_display) não tenha chegado.
function eventStateFor(eventId, liveStart, endDate) {
  var s = getEventState(liveStart, endDate);
  if (s.status === 'live' && window.eventEnded[String(eventId)] === true) {
    return { status: 'ended', text: 'Encerrado', active: false };
  }
  return s;
}

var eventTabsTimerInterval = null;
function startEventTabsTimer() {
  if (eventTabsTimerInterval) clearInterval(eventTabsTimerInterval);
  eventTabsTimerInterval = setInterval(function() {
    document.querySelectorAll('.event-tab[data-end]').forEach(function(tab) {
      var evId = tab.getAttribute('data-event-id');
      if (eventShouldHide(evId)) { tab.remove(); return; } // 3h após o fim real: some
      var state = eventStateFor(evId, tab.getAttribute('data-start'), tab.getAttribute('data-end'));
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
    if (eventShouldHide(event.id)) return; // encerrado há mais de 3h: some da lista
    var name = cleanEventName(event.name);
    var liveStart = event.finish_date_event || event.finish_date_display;
    var endDate = event.finish_date_display || event.finish_date_event;
    var dateLabel = formatEventDate(liveStart);
    var state = eventStateFor(event.id, liveStart, endDate);
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
      // Guarda a lista pra loadVehicles saber o horário de início do evento
      // (e decidir se mostra "Encerrado" ou "Em breve" nos cards).
      window.eventsList = res.data;
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
  // Guarda a hora de início do evento aberto. Se o evento for EM BREVE
  // (start no futuro), o formatTimer dos cards mostra "Em XhYmin" em vez de
  // "Encerrado" — porque o finish_date_offer dos lotes vem como placeholder
  // da origem enquanto o evento não vai ao vivo.
  window.catalogEventStartMs = 0;
  if (window.eventsList) {
    var ev = window.eventsList.find(function(e) { return String(e.id) === String(eventId); });
    if (ev) {
      var startStr = ev.finish_date_event || ev.finish_date_display;
      if (startStr) {
        var ms = new Date(startStr).getTime();
        if (!isNaN(ms)) window.catalogEventStartMs = ms;
      }
    }
  }
  var grid = document.getElementById('vehicles-grid');
  grid.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
  try {
    var res = await api.getEventVehicles(eventId);
    if (res.success && res.data.length > 0) {
      currentVehicles = res.data;
      markEventEnded(eventId, res.data);
      document.getElementById('stat-vehicles').textContent = res.data.length;
      document.getElementById('catalog-count').textContent = res.data.length + ' veículos';
      populateFilters(res.data);
      renderVehicles(res.data);
      startGridTimers();
      startPolling(eventId);
    } else {
      markEventEnded(eventId, []); // sem carros = evento encerrado
      grid.innerHTML = '<div class="empty-state"><i class="fas fa-car-side"></i><h3>Nenhum veículo</h3><p>Nenhum veículo encontrado.</p></div>';
      ensureTestCard();
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
    // Busca os veículos de todos os eventos EM PARALELO (antes era um de cada vez,
    // o que somava a latência de todos e deixava a home lenta pra carregar).
    var lists = await Promise.all(ev.data.map(function(e) {
      return api.getEventVehicles(e.id).then(function(r) {
        var data = (r.success && r.data) ? r.data : [];
        var eid = String(e.id);
        data.forEach(function(x) { x.__eventId = eid; });
        markEventEnded(e.id, data); // marca encerrado se o evento não tem mais carro em disputa
        return data;
      }).catch(function() { markEventEnded(e.id, []); return []; });
    }));
    var all = [].concat.apply([], lists);
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
    var timer = formatTimer(neg.finish_date_offer, neg.start_date_offer);
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
  // Poll a cada 3s. O backend tem cache curto + dedup de requisições em voo, então
  // mesmo com vários clientes a origem é consultada no máximo ~1x a cada 3s. Isso
  // dá sensação de tempo real (junto com o WebSocket, que entra na hora) sem
  // martelar a Dealers. O poll também faz um refresh imediato logo ao abrir.
  pollVehicles(eventId);
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
    if (!res.success || !res.data || res.data.length === 0) { markEventEnded(eventId, []); return; }
    var newVehicles = res.data;
    markEventEnded(eventId, newVehicles);

    // IMPORTANTE: NÃO sair quando a lista muda de tamanho. Em leilão ao vivo os
    // lotes encerram a toda hora e a origem muda o tamanho da lista — se a gente
    // saísse aqui, preço/tempo/ofertas parariam de atualizar (era o bug de "não
    // atualiza nada"). Em vez de re-renderizar (o que resetava a rolagem e dava
    // "carros repetindo"), atualizamos NO LUGAR cada card que já está na tela.
    for (var i = 0; i < newVehicles.length; i++) {
      var nv = newVehicles[i];
      var idx = currentVehicles.findIndex(function(v) { return v.id === nv.id; });
      if (idx === -1) continue; // carro novo: ignora aqui pra não resetar a rolagem
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

      // Atualizar timer no DOM quando finish_date_offer muda (lance estende o
      // tempo). O ticker de 1s lê esse data-end e religa o "AO VIVO" sozinho.
      if (nv.negotiation.finish_date_offer !== old.negotiation.finish_date_offer) {
        var card = document.querySelector('[data-vehicle-id="' + nv.id + '"]');
        if (card) {
          var badge = card.querySelector('.timer-badge[data-end]');
          if (badge) badge.setAttribute('data-end', nv.negotiation.finish_date_offer);
        }
      }

      // Atualizar a contagem de ofertas no card (antes nunca atualizava — ficava
      // travado no número do primeiro carregamento).
      if (nv.offers !== old.offers) {
        var offEl = document.getElementById('offers-' + nv.id);
        if (offEl) {
          var on = nv.offers || 0;
          offEl.textContent = on + ' oferta' + (on > 1 ? 's' : '');
          offEl.style.display = on > 0 ? '' : 'none';
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

// === Catálogo com rolagem infinita (renderiza em lotes) ===
// Renderizar os ~164 cards de uma vez (cada um com carrossel/inputs/timer)
// travava o celular. Agora renderizamos em lotes conforme a pessoa desce.
var _gridList = [];
var _gridIdx = 0;
var GRID_BATCH = 12; // Era 24, baixei pra 12: iOS Safari crashava com muitos cards no DOM
var _gridObserver = null;

function renderVehicles(vehicles) {
  var grid = document.getElementById('vehicles-grid');
  if (!grid) return;
  // Remove duplicados por id (proteção contra carro repetido na lista)
  var _seen = {};
  _gridList = (vehicles || []).filter(function(v) {
    if (!v || _seen[v.id]) return false;
    _seen[v.id] = true;
    return true;
  });
  _gridIdx = 0;
  if (_gridObserver) { _gridObserver.disconnect(); _gridObserver = null; }
  grid.innerHTML = '';
  renderNextGridBatch();
  ensureTestCard();
}

function renderNextGridBatch() {
  var grid = document.getElementById('vehicles-grid');
  if (!grid) return;
  var slice = _gridList.slice(_gridIdx, _gridIdx + GRID_BATCH);
  if (slice.length === 0) return;
  var oldS = document.getElementById('grid-sentinel');
  if (oldS) oldS.remove();
  var html = '';
  slice.forEach(function(v) { html += buildVehicleCardHtml(v); });
  grid.insertAdjacentHTML('beforeend', html);
  _gridIdx += slice.length;
  loadFipeBadges(slice);
  if (_gridIdx < _gridList.length) {
    grid.insertAdjacentHTML('beforeend', '<div id="grid-sentinel" style="grid-column:1/-1;height:1px"></div>');
    var sentinel = document.getElementById('grid-sentinel');
    if (!_gridObserver) {
      _gridObserver = new IntersectionObserver(function(entries) {
        if (entries[0] && entries[0].isIntersecting) renderNextGridBatch();
      // rootMargin curto: só carrega o próximo batch quando o usuário está realmente
      // perto do fim. Era 800px e disparava múltiplos batches em rolagens rápidas.
      }, { rootMargin: '200px' });
    }
    if (sentinel) _gridObserver.observe(sentinel);
  }
}

function buildVehicleCardHtml(v) {
  var html = '';
  {
    var vehicle = v.vehicle;
    var neg = v.negotiation;
    var price = v.offer_actual ? v.offer_actual.price : neg.value_actual;
    var minBid = price + neg.increment;
    var timer = formatTimer(neg.finish_date_offer, neg.start_date_offer);
    // Badges com id fixo e SEMPRE presentes no DOM (mesmo escondidos): assim o
    // ticker de 1s e o poll conseguem ligar/desligar "AO VIVO" / "EM BREVE" e
    // atualizar a contagem de ofertas sem re-renderizar a lista inteira.
    var offN = v.offers || 0;
    var badges = '';
    badges += '<span class="badge badge-live" id="live-' + v.id + '"' + (timer.active ? '' : ' style="display:none"') + '><i class="fas fa-circle"></i> AO VIVO</span>';
    badges += '<span class="badge badge-soon" id="soon-' + v.id + '"' + (timer.upcoming ? '' : ' style="display:none"') + '><i class="fas fa-clock"></i> EM BREVE</span>';
    if (myBids.has(v.id)) badges += '<span class="badge badge-winning" id="status-' + v.id + '"><i class="fas fa-trophy"></i> Levando</span>';
    badges += '<span class="badge badge-offers" id="offers-' + v.id + '"' + (offN > 0 ? '' : ' style="display:none"') + '>' + esc(offN) + ' oferta' + (offN > 1 ? 's' : '') + '</span>';

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

    // Urgency class — não escurece se o evento ainda nem começou.
    var urgencyClass = '';
    var diff = new Date(neg.finish_date_offer) - new Date();
    if (diff <= 0 && !timer.upcoming) urgencyClass = ' card-ended';

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
    html += '<div class="timer-block"><div class="timer-label">' + (timer.upcoming ? 'Inicia em' : 'Encerra em') + '</div>';
    html += '<span class="timer-badge ' + (timer.upcoming ? 'upcoming' : (timer.active ? 'active' : '')) + '" data-end="' + esc(neg.finish_date_offer) + '" data-start="' + esc(neg.start_date_offer || '') + '"><i class="fas fa-clock"></i> <span class="timer-text">' + esc(timer.text) + '</span></span>';
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
  }
  return html;
}

var urgentAlerted = {};

function startGridTimers() {
  if (gridTimerInterval) clearInterval(gridTimerInterval);
  // Tolerância de 5s ao zerar: o card NÃO escurece na hora que o cronômetro
  // bate em 00:00. Mostra "Validando" por 5s; se nesse meio tempo um lance
  // estendeu o tempo lá na origem, o card nem pisca. Se nada chegou, aí
  // escurece de verdade. (Tempo parecido com o que a Dealers usa.)
  var GRACE_MS = 5000;
  // Ticker mais rápido (250ms) pra a tolerância acima ser precisa — caso
  // contrário ele poderia "perder" a janela de 1,5s entre dois ticks de 1s.
  gridTimerInterval = setInterval(function() {
    var now = Date.now() + serverTimeOffset;
    document.querySelectorAll('.timer-badge[data-end]').forEach(function(badge) {
      var end = badge.getAttribute('data-end');
      var start = badge.getAttribute('data-start') || null;
      var endMs = end ? new Date(end).getTime() : NaN;
      var diff = isNaN(endMs) ? null : (endMs - now);
      var timer = formatTimer(end, start);
      // Em tolerância: já zerou mas faz menos de GRACE_MS — mostra "Validando"
      // (mesmo nome que a origem usa) em vez de "Encerrado". Card NÃO escurece.
      // Em "upcoming": evento ainda não começou, mostra a contagem ATÉ o início
      // (NÃO escurece o card, NÃO mostra "AO VIVO" — mostra "EM BREVE").
      var inGrace = !timer.upcoming && diff != null && diff <= 0 && diff > -GRACE_MS;
      var active = timer.active || inGrace;
      var text = inGrace ? 'Validando' : timer.text;
      var textEl = badge.querySelector('.timer-text');
      if (textEl && textEl.textContent !== text) textEl.textContent = text;
      var cls = 'timer-badge ' + (inGrace ? 'validating' : (timer.upcoming ? 'upcoming' : (active ? 'active' : '')));
      if (badge.className !== cls) badge.className = cls;
      var card = badge.closest('.vehicle-card');
      if (card) {
        // "upcoming" NÃO é "ended" — não escurece.
        var ended = !active && !timer.upcoming;
        if (ended !== card.classList.contains('card-ended')) card.classList.toggle('card-ended', ended);
        var vid = card.getAttribute('data-vehicle-id');
        var live = document.getElementById('live-' + vid);
        if (live) {
          // No EM BREVE não mostra "AO VIVO" (vamos mostrar o "EM BREVE" abaixo).
          var want = (ended || timer.upcoming) ? 'none' : '';
          if (live.style.display !== want) live.style.display = want;
        }
        var soon = document.getElementById('soon-' + vid);
        if (soon) {
          var wantSoon = timer.upcoming ? '' : 'none';
          if (soon.style.display !== wantSoon) soon.style.display = wantSoon;
        }
      }
    });
  }, 250);
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
      // Botão "Corrigir FIPE" só pra admin: pega a versão certa quando o
      // auto-match errou (Hilux Manual no lugar de Auto, Nivus Comfortline
      // no lugar de Highline, etc.).
      var isAdmin = !!localStorage.getItem('lp_admin_token');
      var fixBtn = isAdmin
        ? '<button class="fipe-fix-btn" onclick="openFipeFix(' + v.id + ')" title="Corrigir FIPE manualmente"><i class="fas fa-wand-magic-sparkles"></i> Corrigir</button>'
        : '';
      html += '<div class="fipe-detail-title"><span><i class="fas fa-chart-line"></i> Análise FIPE</span>' + fixBtn + '</div>';
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
      var isAdminA = !!localStorage.getItem('lp_admin_token');
      var fixBtnA = isAdminA ? '<button class="fipe-fix-btn" onclick="openFipeFix(' + v.id + ')" title="Corrigir FIPE manualmente"><i class="fas fa-wand-magic-sparkles"></i> Corrigir</button>' : '';
      el.innerHTML = '<div class="fipe-detail-card"><div class="fipe-detail-title"><span><i class="fas fa-chart-line"></i> FIPE indisponível</span>' + fixBtnA + '</div></div>';
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
// CRITICO: TUDO passive:true. Um unico touchmove passive:false no document
// trava o scroll do site inteiro no Chrome Android (browser obrigado a esperar
// JS decidir cada touchmove antes de rolar). A isolacao horizontal vs vertical
// e feita por CSS touch-action: pan-y nos wraps de imagem -- nao precisa
// de preventDefault aqui.
(function() {
  var startX = 0, startY = 0, swipeTarget = null;

  document.addEventListener('touchstart', function(e) {
    var wrap = e.target.closest('.vehicle-card-img-wrap');
    if (!wrap) { swipeTarget = null; return; }
    swipeTarget = wrap;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', function(e) {
    if (!swipeTarget) return;
    var endX = e.changedTouches[0].clientX;
    var endY = e.changedTouches[0].clientY;
    var diffX = endX - startX;
    var diffY = Math.abs(endY - startY);
    if (Math.abs(diffX) > 40 && diffY < Math.abs(diffX)) {
      var cardId = parseInt(swipeTarget.getAttribute('data-card-id'));
      cardCarousel(cardId, diffX < 0 ? 1 : -1);
    }
    swipeTarget = null;
  }, { passive: true });
})();

function openVehicle(id) {
  currentVehicle = currentVehicles.find(function(v) { return v.id === id; });
  if (!currentVehicle) return;
  // Guarda onde a pessoa estava na lista pra voltar no mesmo ponto.
  window.__catalogScroll = window.scrollY || document.documentElement.scrollTop || 0;
  var eventId = currentEvent || localStorage.getItem('lp_event') || '';
  history.pushState(null, '', '#veiculo/' + eventId + '/' + id);
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('page-vehicle').classList.add('active');
  renderVehicleDetail(currentVehicle);
  startTimer();
  window.scrollTo(0, 0);
}

// Volta pro catálogo SEM recarregar a lista (ela já está pronta) e restaura a
// rolagem no ponto onde o cliente estava — assim ele não perde o lugar.
function backToCatalog() {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.nav-link').forEach(function(l) { l.classList.remove('active'); });
  document.getElementById('page-catalog').classList.add('active');
  var navLink = document.querySelector('[data-page="catalog"]');
  if (navLink) navLink.classList.add('active');
  history.pushState(null, '', '#catalog');
  var y = window.__catalogScroll || 0;
  // restaura em 2 frames pra garantir que o layout do catálogo já voltou
  window.scrollTo(0, y);
  requestAnimationFrame(function() { window.scrollTo(0, y); });
}

function renderVehicleDetail(v) {
  var vehicle = v.vehicle;
  var neg = v.negotiation;
  var price = v.offer_actual ? v.offer_actual.price : neg.value_actual;
  var minBid = price + neg.increment;
  var images = getVehicleImages(vehicle);
  var thumbs = getVehicleThumbs(vehicle); // CRITICO iOS: strip usa thumb pequena, NAO full-res
  var mainImg = images.length > 0 ? images[0] : '';

  // Thumbnail strip: usa imagens PEQUENAS (.thumb), o full-res so vai no main
  // e no lightbox. Antes carregava 8x full-res aqui (centenas de KB cada),
  // estourava a memoria da aba no iOS Safari ("Um problema ocorreu repetidamente").
  var thumbsHtml = '';
  thumbs.slice(0, 8).forEach(function(tUrl, i) {
    var fullUrl = images[i] || tUrl;
    thumbsHtml += '<img src="' + esc(tUrl) + '" onclick="changeImage(\'' + esc(fullUrl).replace(/'/g, "\\'") + '\')" class="' + (i === 0 ? 'active' : '') + '" loading="lazy" decoding="async">';
  });

  var html = '<button class="btn-back-catalog" onclick="backToCatalog()"><i class="fas fa-arrow-left"></i> Voltar aos Lotes</button>';
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
  // Botão "baixar todas as fotos" — fica ABAIXO do título/subtítulo e ANTES
  // do bid-section, num lugar limpo onde não sobrepõe com nada.
  if (images.length > 0) {
    html += '<button id="pub-dl-all-btn" onclick="pubDownloadAllPhotos(' + v.id + ')" style="width:100%;background:rgba(108,92,231,0.18);color:#a29bfe;border:1px solid rgba(108,92,231,0.45);padding:12px;border-radius:10px;cursor:pointer;font-size:0.88rem;font-weight:600;margin:14px 0;display:flex;align-items:center;justify-content:center;gap:8px;position:relative;z-index:2"><i class="fas fa-download"></i> Baixar todas as fotos (' + images.length + ')</button>';
  }
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
  // Preload SO das vizinhas (anterior e proxima). Antes preloadava as 8 de uma
  // vez = estouro de memoria no iOS Safari. Agora o navegador busca sob demanda
  // quando o usuario navega — a perda visual e minima (1 piscada na 1a troca).
  lbPreloadNeighbors();
}

function lbPreloadNeighbors() {
  var n = lightboxImages.length;
  if (n < 2) return;
  var prev = (lightboxIndex - 1 + n) % n;
  var next = (lightboxIndex + 1) % n;
  [prev, next].forEach(function(i){ if (lightboxImages[i]) { (new Image()).src = lightboxImages[i]; } });
}

function closeLightbox() {
  var overlay = document.getElementById('lightbox');
  overlay.classList.remove('active');
  overlay.style.background = '';
  lbResetZoom();
}

// === Download de fotos do detalhe (público) ===
// Sanitiza marca/modelo pra nome de arquivo (sem acentos/espaços bagunçados)
function _fileSafeName(s) {
  return String(s || 'foto').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

// URL pra download: força via /api/img (proxy mesmo-origem). CDN cross-origin
// dá CORS error no fetch — mesmo bug que tinha no admin.
function _downloadSrcPub(u) {
  if (!u) return u;
  if (/^\/api\/img/.test(u)) return u;
  return '/api/img?url=' + encodeURIComponent(u);
}

function _triggerDownloadPub(blob, name) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

async function lbDownloadCurrent() {
  if (!lightboxImages.length || !currentVehicle) return;
  var photo = lightboxImages[lightboxIndex];
  var vh = currentVehicle.vehicle || {};
  var prefix = _fileSafeName(vh.brand_name) + '_' + _fileSafeName(vh.model_name);
  var name = prefix + '_' + (lightboxIndex + 1) + '.jpg';
  try {
    var res = await fetch(_downloadSrcPub(photo));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var blob = await res.blob();
    _triggerDownloadPub(blob, name);
  } catch(e) {
    window.open(_downloadSrcPub(photo), '_blank');
  }
}

async function pubDownloadAllPhotos(vehicleId) {
  if (typeof JSZip === 'undefined') { showToast('A biblioteca de zip não carregou — recarregue a página.', 'error'); return; }
  if (!currentVehicle || currentVehicle.id !== vehicleId) return;
  var photos = getVehicleImages(currentVehicle.vehicle);
  if (!photos.length) { showToast('Sem fotos pra baixar.', 'error'); return; }
  var vh = currentVehicle.vehicle || {};
  var prefix = _fileSafeName(vh.brand_name) + '_' + _fileSafeName(vh.model_name);
  var btn = document.getElementById('pub-dl-all-btn');
  var setBtn = function(txt) { if (btn) btn.innerHTML = txt; };
  if (btn) { btn.disabled = true; btn.style.opacity = '0.7'; }
  try {
    var zip = new JSZip();
    var failed = 0;
    for (var i = 0; i < photos.length; i++) {
      setBtn('<i class="fas fa-spinner fa-spin"></i> Baixando ' + (i+1) + '/' + photos.length + '…');
      try {
        var res = await fetch(_downloadSrcPub(photos[i]));
        if (!res.ok) { failed++; continue; }
        var blob = await res.blob();
        zip.file(prefix + '_' + String(i+1).padStart(2,'0') + '.jpg', blob);
      } catch (e) { failed++; }
    }
    if (failed === photos.length) throw new Error('Nenhuma foto foi baixada');
    setBtn('<i class="fas fa-spinner fa-spin"></i> Compactando…');
    var content = await zip.generateAsync({ type: 'blob' });
    _triggerDownloadPub(content, prefix + '_fotos.zip');
    setBtn('<i class="fas fa-check"></i> Pronto!');
    setTimeout(function(){
      setBtn('<i class="fas fa-download"></i> Baixar todas as fotos (' + photos.length + ')');
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
    }, 2500);
  } catch (e) {
    setBtn('<i class="fas fa-download"></i> Baixar todas as fotos (' + photos.length + ')');
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
    showToast('Erro ao baixar: ' + e.message, 'error');
  }
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
  // Preload das vizinhas da nova posicao (mantém o "deslize sem piscar" sem
  // ter todas as 8 imagens em memoria simultaneamente).
  lbPreloadNeighbors();

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
  // Mesma tolerância de 5s da grade: o relógio de detalhe não pula direto pra
  // "Encerrado" quando zera — mostra "Validando" esperando o lance-relâmpago.
  var GRACE_MS = 5000;
  timerInterval = setInterval(function() {
    if (!currentVehicle) return;
    var end = currentVehicle.negotiation.finish_date_offer;
    var start = currentVehicle.negotiation.start_date_offer;
    var endMs = end ? new Date(end).getTime() : NaN;
    var now = Date.now() + serverTimeOffset;
    var diff = isNaN(endMs) ? null : (endMs - now);
    var timer = formatTimer(end, start);
    var inGrace = diff != null && diff <= 0 && diff > -GRACE_MS;
    var el = document.getElementById('detail-timer');
    if (el) el.textContent = inGrace ? 'Validando' : timer.text;
  }, 250);
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
    initial_price: v.negotiation ? v.negotiation.value_initial : null,
    // Tempo de fechamento do lote — usado pelo cron de reconciliacao no backend
    // pra saber quando bater na Dealers e descobrir quem ganhou. Sem isso o cron
    // teria que checar TODOS os lances pendentes a cada execucao.
    finish_date_offer: v.negotiation ? v.negotiation.finish_date_offer : null,
    start_date_offer: v.negotiation ? v.negotiation.start_date_offer : null
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
      if (res.error === 'Token inválido' || res.error === 'Faça login para continuar') {
        if (typeof handleSessionExpired === 'function') handleSessionExpired();
      } else if (res.code === 'TERMS_OUTDATED') {
        if (typeof showTermsReacceptModal === 'function') showTermsReacceptModal();
        else showToast(res.error, 'warning', 6000);
      } else if (res.code === 'NO_DOCUMENTS') {
        showToast(res.error, 'warning', 8000);
        setTimeout(function(){ if (typeof navigateTo === 'function') navigateTo('profile'); }, 1500);
      } else if (res.code === 'DOCS_PENDING') {
        showToast(res.error, 'warning', 9000);
      } else {
        showToast(res.error || 'Não foi possível enviar a oferta', 'error');
      }
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
      if (res.error === 'Token inválido' || res.error === 'Faça login para continuar') {
        if (typeof handleSessionExpired === 'function') handleSessionExpired();
      } else if (res.code === 'TERMS_OUTDATED') {
        if (typeof showTermsReacceptModal === 'function') showTermsReacceptModal();
        else showToast(res.error, 'warning', 6000);
      } else if (res.code === 'NO_DOCUMENTS') {
        showToast(res.error, 'warning', 8000);
        setTimeout(function(){ if (typeof navigateTo === 'function') navigateTo('profile'); }, 1500);
      } else if (res.code === 'DOCS_PENDING') {
        showToast(res.error, 'warning', 9000);
      } else {
        showToast(res.error || 'Não foi possível enviar a oferta', 'error');
      }
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
  // Para reativar, remova o "return false;" e descomente o bloco abaixo.
  return false;
  /* try {
    if (/[?&]test=0(?:&|$)/.test(window.location.search)) { localStorage.removeItem('lp_testmode'); return false; }
    if (/[?&]test=1(?:&|$)/.test(window.location.search)) { localStorage.setItem('lp_testmode', '1'); return true; }
    return localStorage.getItem('lp_testmode') === '1';
  } catch (e) { return false; } */
}

function ensureTestCard() {
  if (!isTestMode()) return;
  var grid = document.getElementById('vehicles-grid');
  if (!grid || grid.querySelector('.test-card')) return;
  grid.insertAdjacentHTML('afterbegin', testCardHtml());
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
// Visual de cada status persistido (cor, label, icone) num so lugar.
var BID_STATUS_STYLE = {
  levando:           { color: '#00b894', label: 'Levando agora',          icon: 'fa-trophy',        section: 'ativos' },
  coberto:           { color: '#ff7675', label: 'Coberto',                 icon: 'fa-arrow-down',    section: 'ativos' },
  pendente:          { color: '#fdcb6e', label: 'Aguardando',              icon: 'fa-clock',         section: 'ativos' },
  venceu_aguardando: { color: '#fdcb6e', label: 'Você venceu — aguardando aprovação', icon: 'fa-hourglass-half', section: 'encerrados' },
  aprovado:          { color: '#00b894', label: 'Aprovado — compra liberada',  icon: 'fa-check-circle', section: 'encerrados' },
  perdeu:            { color: '#8892b0', label: 'Não venceu',              icon: 'fa-times-circle',  section: 'encerrados' },
  rejeitado:         { color: '#ff7675', label: 'Rejeitado pelo admin',    icon: 'fa-ban',           section: 'encerrados' }
};

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
    if (!data.success && !data.data) {
      document.getElementById('dash-disputes-list').innerHTML = '<div class="empty-state" style="padding:40px"><i class="fas fa-exclamation-triangle"></i><h3>Erro</h3><p>' + (data.error || 'falha ao buscar lances') + '</p></div>';
      return;
    }
    var bids = data.data || [];
    document.getElementById('dash-total-offers').textContent = bids.length;

    // Contadores: "Ganhando" agrupa levando + venceu/aprovado.
    // "Perdendo" agrupa coberto + perdeu + rejeitado. "Compras" = aprovados.
    var winning = 0, losing = 0, purchases = 0;
    var ativos = [], encerrados = [];
    bids.forEach(function(b){
      var st = BID_STATUS_STYLE[b.status] || BID_STATUS_STYLE.pendente;
      if (st.section === 'ativos') ativos.push(b); else encerrados.push(b);
      if (b.status === 'levando' || b.status === 'venceu_aguardando' || b.status === 'aprovado') winning++;
      if (b.status === 'coberto' || b.status === 'perdeu' || b.status === 'rejeitado') losing++;
      if (b.status === 'aprovado') purchases++;
    });

    function renderItem(b) {
      var st = BID_STATUS_STYLE[b.status] || BID_STATUS_STYLE.pendente;
      var vehicle = (b.vehicle_brand + ' ' + b.vehicle_model).trim() || 'Veículo #' + b.advertisement_id;
      var valor = parseFloat(b.bid_value);
      var date = new Date(b.created_at).toLocaleString('pt-BR');
      var tipo = b.bid_type === 'automatico'
        ? '<span style="background:rgba(0,184,148,0.15);color:#00b894;padding:2px 6px;border-radius:4px;font-size:0.7rem">Auto</span>'
        : '<span style="background:rgba(108,92,231,0.15);color:#a29bfe;padding:2px 6px;border-radius:4px;font-size:0.7rem">Manual</span>';
      // Pra lances ja encerrados, mostra valor final tambem (se diferente)
      var finalLine = '';
      if (b.final_price && parseFloat(b.final_price) > 0 && st.section === 'encerrados') {
        finalLine = '<div style="font-size:0.75rem;color:#8892b0;margin-top:2px">Valor final: ' + formatCurrency(parseFloat(b.final_price)) + '</div>';
      }
      var html = '<div class="dash-offer-item" onclick="openBidVehicle(' + b.advertisement_id + ',' + (valor || 0) + ',\'' + (b.status || '') + '\')" style="border-left:3px solid '+st.color+';padding-left:12px;cursor:pointer">';
      html += '<div class="dash-offer-info">';
      html += '<strong>' + vehicle + ' <i class="fas fa-chevron-right" style="font-size:0.7rem;color:#8892b0;margin-left:4px"></i></strong>';
      html += '<span>' + formatCurrency(valor) + ' — ' + date + ' ' + tipo + '</span>';
      html += finalLine;
      html += '</div>';
      html += '<span style="color:'+st.color+';font-weight:600;font-size:0.8rem;text-align:right;white-space:nowrap"><i class="fas '+st.icon+'"></i> ' + st.label + '</span>';
      html += '</div>';
      return html;
    }

    var dHtml = ativos.length === 0
      ? '<div class="empty-state" style="padding:30px"><i class="fas fa-inbox"></i><p style="margin-top:8px;color:#8892b0">Nenhum lance ativo.</p></div>'
      : ativos.map(renderItem).join('');
    document.getElementById('dash-disputes-list').innerHTML = dHtml;

    // Card de pagamento — aparece se cliente tem lance vencedor (aguardando ou aprovado).
    // Mostra dados bancarios do dono pro cliente fazer PIX/TED manual (modo
    // provisorio enquanto gateway nao integra).
    var hasWin = bids.some(function(b) { return b.outcome === 'venceu'; });
    renderUrgentWinnerBanner(bids);
    renderPaymentCardIfWinner(bids, hasWin);

    var hHtml = encerrados.length === 0
      ? '<div class="empty-state" style="padding:30px"><i class="fas fa-history"></i><p style="margin-top:8px;color:#8892b0">Nenhum leilão encerrado ainda.</p></div>'
      : encerrados.map(renderItem).join('');
    document.getElementById('dash-offers-list').innerHTML = hHtml;

    document.getElementById('dash-winning').textContent = winning;
    document.getElementById('dash-losing').textContent = losing;
    document.getElementById('dash-purchases').textContent = purchases;

    // Se o cliente tem qualquer lance ativo ou aguardando reconciliacao, pede
    // permissao de notificacao do navegador uma unica vez (pra quando ganhar
    // a notif funcionar mesmo com aba minimizada).
    if ((ativos.length > 0 || bids.some(function(b){return !b.outcome;})) && 'Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch (e) {}
    }
  } catch (err) {
    document.getElementById('dash-disputes-list').innerHTML = '<div class="empty-state" style="padding:40px"><i class="fas fa-exclamation-triangle"></i><h3>Erro</h3><p>' + err.message + '</p></div>';
  }
}

// Auto-refresh do "Meu Painel" do cliente: enquanto a pagina estiver visivel
// e o usuario estiver na tela do dashboard, re-busca os lances a cada 10s.
// Pausa quando a aba vai pra background (poupa bateria/API). Tambem reage a
// eventos do WebSocket (bid_update) pra ficar quase em tempo real.
var dashRefreshTimer = null;
function startDashboardAutoRefresh() {
  stopDashboardAutoRefresh();
  function tick() {
    if (document.visibilityState !== 'visible') return; // aba escondida = nao bate na API
    var page = document.getElementById('page-dashboard');
    if (!page || !page.classList.contains('active')) { stopDashboardAutoRefresh(); return; }
    loadDashboard();
  }
  dashRefreshTimer = setInterval(tick, 10000);
}
function stopDashboardAutoRefresh() {
  if (dashRefreshTimer) { clearInterval(dashRefreshTimer); dashRefreshTimer = null; }
}
// Refresh imediato quando o catalogo WS dispara bid_update — alguem deu lance,
// pode ter coberto o cliente. Ouve evento custom 'lp:bid-update' que o
// websocket handler ja dispara (ver connectWebSocket no app.js).
document.addEventListener('lp:bid-update', function() {
  var page = document.getElementById('page-dashboard');
  if (page && page.classList.contains('active') && document.visibilityState === 'visible') {
    loadDashboard();
  }
});

// === Banner URGENTE "Voce venceu, pague em X:XX" ===
// Aparece quando ha lances com outcome='venceu' E payment_deadline ainda no
// futuro. Inclui countdown ao vivo, som de alerta e notificacao do navegador
// (se o usuario tiver permitido). Idempotente: dispara som/notif so na 1a vez
// por bid_id (lp_winner_seen no localStorage controla).
var winnerCountdownTimer = null;

function renderUrgentWinnerBanner(bids) {
  var card = document.getElementById('dash-payment-card');
  if (!card) return;
  // Lances vencedores com prazo ainda valido (deadline no futuro)
  var now = Date.now();
  var urgent = bids.filter(function(b) {
    if (b.outcome !== 'venceu') return false;
    if (b.admin_approved === true) return false; // ja foi confirmado pelo admin
    if (!b.payment_deadline) return false;
    var dl = new Date(b.payment_deadline).getTime();
    return !isNaN(dl) && dl > now - 60000; // mantem ate 1min apos vencer (mostra "expirado")
  });

  // Limpa timer anterior (vamos recriar)
  if (winnerCountdownTimer) { clearInterval(winnerCountdownTimer); winnerCountdownTimer = null; }

  // Some o banner se nao tem nada urgente
  var bannerWrap = document.getElementById('dash-winner-banner');
  if (urgent.length === 0) {
    if (bannerWrap) bannerWrap.remove();
    return;
  }

  if (!bannerWrap) {
    bannerWrap = document.createElement('div');
    bannerWrap.id = 'dash-winner-banner';
    bannerWrap.style.cssText = 'margin-bottom:18px';
    // Insere ANTES do dash-payment-card
    card.parentNode.insertBefore(bannerWrap, card);
  }

  // Pega o lance que vence PRIMEIRO (deadline mais proximo) — esse e o cronometro principal
  urgent.sort(function(a, b){ return new Date(a.payment_deadline) - new Date(b.payment_deadline); });
  var first = urgent[0];
  var vehicle = (first.vehicle_brand + ' ' + first.vehicle_model).trim() || 'Veículo';
  var sinal = (parseFloat(first.final_price || first.bid_value) || 0) * 0.10;
  var deadlineMs = new Date(first.payment_deadline).getTime();

  function fmtRemaining(ms) {
    if (ms <= 0) return 'PRAZO EXPIRADO';
    var m = Math.floor(ms / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  }

  function render() {
    var remain = deadlineMs - Date.now();
    var isExpired = remain <= 0;
    var bg = isExpired ? 'linear-gradient(135deg,#7a0000,#3a0000)' : 'linear-gradient(135deg,#d63031,#a00)';
    var icon = isExpired ? 'fa-circle-xmark' : 'fa-circle-exclamation';
    var pulseStyle = isExpired ? '' : 'animation:winnerPulse 1.4s ease-in-out infinite';
    bannerWrap.innerHTML =
      '<div style="background:'+bg+';border:2px solid '+(isExpired?'#7a0000':'#ff7675')+';border-radius:14px;padding:24px;color:#fff;'+pulseStyle+';text-align:center">' +
        '<div style="font-size:0.78rem;letter-spacing:2px;font-weight:700;opacity:0.85;text-transform:uppercase;margin-bottom:6px"><i class="fas '+icon+'"></i> '+(isExpired?'Prazo vencido':'Você venceu! Pague o sinal agora')+'</div>' +
        '<div style="font-family:\'Space Grotesk\',sans-serif;font-size:2.6rem;font-weight:700;font-variant-numeric:tabular-nums;line-height:1;margin:8px 0">' + fmtRemaining(remain) + '</div>' +
        '<div style="font-size:0.9rem;opacity:0.95;margin-top:6px"><strong>'+esc(vehicle)+'</strong> — sinal de '+formatCurrency(sinal)+(urgent.length>1?' (e mais '+(urgent.length-1)+')':'')+'</div>' +
        (isExpired ? '<div style="font-size:0.82rem;margin-top:10px;background:rgba(0,0,0,0.25);padding:8px 14px;border-radius:8px;display:inline-block">Sua oferta foi cancelada. A multa de 10% (e adicional) se aplica conforme o item 4 dos termos.</div>'
                   : '<div style="font-size:0.82rem;margin-top:10px;opacity:0.85">Role abaixo pra ver os dados de PIX</div>') +
      '</div>' +
      '<style>@keyframes winnerPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(255, 118, 117, 0.5); } 50% { box-shadow: 0 0 0 14px rgba(255, 118, 117, 0); } }</style>';
  }

  render();
  winnerCountdownTimer = setInterval(function() {
    // Para o timer se a pagina nao esta visivel ou o cliente saiu do dashboard
    var page = document.getElementById('page-dashboard');
    if (!page || !page.classList.contains('active')) { clearInterval(winnerCountdownTimer); winnerCountdownTimer = null; return; }
    render();
  }, 1000);

  // Alerta sonoro + notif do navegador SO se for a primeira vez vendo este lance vencedor
  try {
    var seen = JSON.parse(localStorage.getItem('lp_winner_seen') || '[]');
    urgent.forEach(function(b) {
      if (seen.indexOf(b.id) === -1) {
        seen.push(b.id);
        playWinnerAlert(vehicle, sinal);
      }
    });
    localStorage.setItem('lp_winner_seen', JSON.stringify(seen.slice(-50)));
  } catch (e) { /* ignora */ }
}

// Toca um beep crescente (Web Audio API — sem precisar de arquivo de audio)
// + notificacao do navegador se permitida. Chamado SO uma vez por bid.
function playWinnerAlert(vehicle, sinal) {
  // Som
  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      var ctx = new Ctx();
      var notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
      notes.forEach(function(freq, i) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = freq;
        o.type = 'sine';
        g.gain.setValueAtTime(0, ctx.currentTime + i * 0.15);
        g.gain.linearRampToValueAtTime(0.3, ctx.currentTime + i * 0.15 + 0.02);
        g.gain.linearRampToValueAtTime(0, ctx.currentTime + i * 0.15 + 0.18);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + i * 0.15);
        o.stop(ctx.currentTime + i * 0.15 + 0.2);
      });
    }
  } catch (e) { /* navegadores com restricao */ }

  // Notificacao do navegador
  try {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification('🏆 Você venceu o leilão!', {
          body: vehicle + ' — pague R$ ' + sinal.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' em 5 minutos.',
          icon: '/assets/logo-192.png',
          badge: '/assets/logo-192.png',
          requireInteraction: true,
        });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission();
      }
    }
  } catch (e) { /* ignora */ }
}

// === Card "Como pagar o sinal" pro cliente vencedor ===
async function renderPaymentCardIfWinner(bids, hasWin) {
  var card = document.getElementById('dash-payment-card');
  if (!card) return;
  if (!hasWin) { card.style.display = 'none'; card.innerHTML = ''; return; }
  try {
    var token = localStorage.getItem('lp_token');
    var res = await fetch('/api/me/payment-info', { headers: { 'Authorization': 'Bearer ' + token } });
    var j = await res.json();
    if (!j.success || !j.payment) { card.style.display = 'none'; return; }
    var p = j.payment;
    // Total devido = 10% da soma dos lances vencedores (multiplos lotes = mais de uma linha)
    var wins = bids.filter(function(b){ return b.outcome === 'venceu'; });
    var totalSinal = wins.reduce(function(acc, b){ return acc + (parseFloat(b.final_price || b.bid_value) || 0) * 0.10; }, 0);
    var nWins = wins.length;
    var listWins = wins.map(function(b){
      var n = (b.vehicle_brand + ' ' + b.vehicle_model).trim() || 'Lance #' + b.id;
      var v = parseFloat(b.final_price || b.bid_value) || 0;
      return '<div style="display:flex;justify-content:space-between;font-size:0.82rem;padding:4px 0;border-bottom:1px dashed rgba(255,255,255,0.06)"><span>' + esc(n) + '</span><span style="font-variant-numeric:tabular-nums;color:#fdcb6e">' + formatCurrency(v * 0.10) + '</span></div>';
    }).join('');

    function row(label, value, copyKey) {
      if (!value) return '';
      var copyAttr = copyKey ? (' data-copy="' + esc(value).replace(/"/g,'&quot;') + '"') : '';
      return '<div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05)' + (copyKey?';cursor:pointer"' + copyAttr + ' onclick="pmCopy(this)"':'"') + '><span style="color:#8892b0;font-size:0.78rem">' + label + '</span><strong style="color:#fff;font-size:0.88rem;text-align:right;word-break:break-all">' + esc(value) + (copyKey?' <i class="fas fa-copy" style="margin-left:6px;color:#a29bfe;font-size:0.78rem"></i>':'') + '</strong></div>';
    }

    card.style.display = 'block';
    card.innerHTML =
      '<div style="background:linear-gradient(135deg,rgba(253,203,110,0.18),rgba(253,203,110,0.06));border:1px solid rgba(253,203,110,0.4);border-radius:14px;padding:22px 24px">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">' +
          '<i class="fas fa-trophy" style="color:#fdcb6e;font-size:1.2rem"></i>' +
          '<h3 style="margin:0;color:#fff;font-family:\'Space Grotesk\',sans-serif">Parabéns, você venceu '+(nWins>1?nWins+' leilões':'um leilão')+'!</h3>' +
        '</div>' +
        '<p style="color:#d6d7df;font-size:0.88rem;margin:8px 0 16px;line-height:1.55">Faça o PIX do <strong style="color:#fdcb6e">sinal de 10%</strong> nos dados abaixo. <strong>Prazo: 5 minutos</strong> a partir da aprovação da loja. Sem o sinal no prazo, a oferta é cancelada e a multa do item 4 dos termos se aplica.</p>' +

        '<div style="background:rgba(0,0,0,0.25);border-radius:10px;padding:14px 18px;margin-bottom:14px">' +
          '<div style="font-size:0.72rem;color:#8892b0;text-transform:uppercase;letter-spacing:1.2px;font-weight:700;margin-bottom:8px">Valor do sinal (10%)</div>' +
          listWins +
          '<div style="display:flex;justify-content:space-between;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.12)"><strong style="font-size:0.95rem">Total a pagar agora</strong><strong style="font-family:\'Space Grotesk\',sans-serif;color:#fdcb6e;font-size:1.4rem;font-variant-numeric:tabular-nums">' + formatCurrency(totalSinal) + '</strong></div>' +
        '</div>' +

        '<div style="background:rgba(255,255,255,0.04);border-radius:10px;padding:14px 18px">' +
          '<div style="font-size:0.72rem;color:#fdcb6e;text-transform:uppercase;letter-spacing:1.2px;font-weight:700;margin-bottom:8px">Dados pra PIX/TED</div>' +
          row('Razão Social', p.pay_razao_social) +
          row('CNPJ/CPF', p.pay_cnpj, true) +
          row('Chave PIX ('+ (p.pay_pix_tipo||'') +')', p.pay_pix_key, true) +
          (p.pay_banco ? row('Banco', p.pay_banco) : '') +
          (p.pay_agencia ? row('Agência', p.pay_agencia) : '') +
          (p.pay_conta ? row('Conta', p.pay_conta) : '') +
        '</div>' +

        (p.pay_observacoes ? '<div style="margin-top:14px;padding:12px 14px;background:rgba(108,92,231,0.12);border-left:3px solid #a29bfe;border-radius:6px;font-size:0.85rem;color:#d6d7df;line-height:1.5"><i class="fas fa-info-circle" style="color:#a29bfe;margin-right:6px"></i>' + esc(p.pay_observacoes) + '</div>' : '') +
      '</div>';
  } catch (e) {
    card.style.display = 'none';
  }
}

// Copia campo da seção de pagamento ao clicar
function pmCopy(el) {
  var v = el.getAttribute('data-copy');
  if (!v) return;
  navigator.clipboard.writeText(v).then(function(){
    var icon = el.querySelector('i');
    if (icon) { icon.className = 'fas fa-check'; icon.style.color = '#00b894'; setTimeout(function(){ icon.className = 'fas fa-copy'; icon.style.color = '#a29bfe'; }, 1500); }
    if (typeof showToast === 'function') showToast('Copiado!', 'success', 1500);
  }).catch(function(){});
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
  html += '<p style="color:#8892b0;font-size:0.82rem;margin-bottom:14px">Envie sua <strong>CNH</strong> (foto ou versão digital em PDF), <strong>RG</strong> e <strong>comprovante de endereço</strong>. Imagem ou PDF, até 5MB cada.</p>';
  html += '<div id="pf-docs" style="margin-bottom:14px">Carregando…</div>';
  // 3 botoes categorizados — cada um salva o doc_type certo pro admin distinguir.
  // accept inclui image/* (camera no celular abre direto) + PDF (CNH digital).
  html += '<div style="display:flex;flex-wrap:wrap;gap:8px">';
  html += '<label class="btn btn-glass" style="cursor:pointer;font-size:0.85rem"><i class="fas fa-id-card" style="color:#fdcb6e"></i> CNH (foto ou digital)<input type="file" accept="image/*,application/pdf" style="display:none" onchange="uploadDoc(this,\'cnh\')"></label>';
  html += '<label class="btn btn-glass" style="cursor:pointer;font-size:0.85rem"><i class="fas fa-address-card" style="color:#a29bfe"></i> RG<input type="file" accept="image/*,application/pdf" style="display:none" onchange="uploadDoc(this,\'rg\')"></label>';
  html += '<label class="btn btn-glass" style="cursor:pointer;font-size:0.85rem"><i class="fas fa-house" style="color:#00b894"></i> Comprovante de endereço<input type="file" accept="image/*,application/pdf" style="display:none" onchange="uploadDoc(this,\'comprovante_residencia\')"></label>';
  html += '<label class="btn btn-glass" style="cursor:pointer;font-size:0.85rem;opacity:0.85"><i class="fas fa-file" style="color:#8892b0"></i> Outro<input type="file" accept="image/*,application/pdf" style="display:none" onchange="uploadDoc(this,\'outro\')"></label>';
  html += '</div>';
  html += '<div id="pf-doc-status" style="margin-top:10px;font-size:0.85rem;min-height:18px"></div>';
  html += '</div>';

  // Sair da conta
  html += '<div style="margin:8px 0 44px"><button class="btn btn-glass" onclick="logout();navigateTo(\'home\');" style="color:#ff7675;border-color:rgba(255,118,117,0.4)"><i class="fas fa-sign-out-alt"></i> Sair da conta</button></div>';

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
    var TYPE_META = {
      cnh:                    { label: 'CNH',                       icon: 'fa-id-card',      color: '#fdcb6e' },
      rg:                     { label: 'RG',                        icon: 'fa-address-card', color: '#a29bfe' },
      comprovante_residencia: { label: 'Comprovante de endereço',   icon: 'fa-house',        color: '#00b894' },
      outro:                  { label: 'Documento',                 icon: 'fa-file',         color: '#8892b0' },
      documento:              { label: 'Documento',                 icon: 'fa-file',         color: '#8892b0' }
    };
    var html = '';
    docs.forEach(function(d) {
      var meta = TYPE_META[d.doc_type] || TYPE_META.outro;
      // Status de aprovacao visivel pro cliente saber se ja pode dar lance.
      var statusHtml = '';
      if (d.verified === true) {
        statusHtml = '<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(0,184,148,0.15);color:#00b894;padding:2px 8px;border-radius:999px;font-size:0.68rem;font-weight:700"><i class="fas fa-check-circle"></i> Aprovado</span>';
      } else if (d.rejected_reason) {
        statusHtml = '<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(255,118,117,0.15);color:#ff7675;padding:2px 8px;border-radius:999px;font-size:0.68rem;font-weight:700"><i class="fas fa-ban"></i> Rejeitado</span>';
      } else {
        statusHtml = '<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(253,203,110,0.15);color:#fdcb6e;padding:2px 8px;border-radius:999px;font-size:0.68rem;font-weight:700"><i class="fas fa-clock"></i> Em análise</span>';
      }
      html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05);flex-wrap:wrap">';
      html += '<span style="display:flex;align-items:center;gap:10px;min-width:0;flex:1">';
      html += '<span style="display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,0.05);border:1px solid '+meta.color+'40;color:'+meta.color+';padding:3px 9px;border-radius:999px;font-size:0.7rem;font-weight:700;flex-shrink:0"><i class="fas '+meta.icon+'"></i> '+meta.label+'</span>';
      html += '<span style="display:flex;flex-direction:column;min-width:0;gap:3px">';
      html += '<span style="font-size:0.82rem;color:#c9c9d6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(d.filename || 'arquivo')+'</span>';
      html += statusHtml;
      if (d.rejected_reason) html += '<span style="font-size:0.7rem;color:#ff7675;margin-top:2px"><i class="fas fa-info-circle"></i> ' + esc(d.rejected_reason) + ' — envie um novo</span>';
      html += '</span>';
      html += '</span>';
      html += '<span style="display:flex;gap:6px;flex-shrink:0"><button class="btn btn-glass" style="padding:5px 10px;font-size:0.72rem" onclick="viewDoc(' + d.id + ')">Ver</button><button class="btn btn-glass" style="padding:5px 10px;font-size:0.72rem;color:#ff7675" onclick="deleteDoc(' + d.id + ')">Excluir</button></span>';
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

function uploadDoc(input, docType) {
  var file = input.files && input.files[0];
  if (!file) return;
  var st = document.getElementById('pf-doc-status');
  var typeLabel = ({ cnh:'CNH', rg:'RG', comprovante_residencia:'Comprovante de residência', outro:'Documento' })[docType] || 'Documento';
  st.style.color = '#fdcb6e'; st.textContent = 'Enviando ' + typeLabel + '…';
  var send = function(base64, mime) {
    fetch('/api/auth/me/documents', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('lp_token') }, body: JSON.stringify({ doc_type: docType || 'documento', filename: file.name, mime: mime, data: base64 }) })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.success) { st.style.color = '#00b894'; st.textContent = '✓ ' + typeLabel + ' enviado'; loadProfileDocs(); }
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
        backToCatalog();
      }
    }
  }, { passive: true });
})();

(async function restoreState() {
  initPromoBanner();
  var hash = window.location.hash.replace('#', '');
  // URLs amigáveis (/loja, /vitrine, /showroom) servem index.html — aqui a
  // gente detecta a rota e abre a Vitrine direto, sem passar pela home.
  var pathname = window.location.pathname.toLowerCase();
  if (/^\/(loja|vitrine|showroom)\/?$/.test(pathname)) {
    navigateTo('showroom');
    return;
  }
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
  } else if (hash === 'showroom' || hash === 'vitrine') {
    navigateTo('showroom');
    return;
  } else if (hash === 'how') {
    navigateTo('how');
    return;
  } else if (hash === 'dashboard') {
    navigateTo('dashboard');
    return;
  } else if (hash === 'profile') {
    navigateTo('profile');
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
  } else if (hash === 'catalog') {
    // Se está voltando da tela de um veículo, preserva a rolagem da lista.
    var vp = document.getElementById('page-vehicle');
    if (vp && vp.classList.contains('active')) backToCatalog();
    else navigateTo('catalog');
  } else if (hash === 'how' || hash === 'dashboard') {
    navigateTo(hash);
  } else if (hash === 'showroom' || hash === 'vitrine') {
    navigateTo('showroom');
  } else if (hash === 'profile') {
    navigateTo('profile');
  } else {
    navigateTo('home');
  }
});

// Abre o laudo cautelar com tela de "preparando" enquanto o servidor redige
// (remove o nome da origem). A 1ª vez de cada laudo pode levar alguns segundos
// (OCR); depois é instantâneo (cache do servidor). Abrimos a aba já no clique
// pra não cair no bloqueador de pop-up, e trocamos pro PDF quando fica pronto.
function openLaudo(encodedUrl) {
  // Carimbo único por abertura: garante que o navegador nunca sirva uma versão
  // antiga (cacheada) do laudo. O trabalho pesado fica no cache do servidor.
  var proxyUrl = '/api/laudo-proxy?url=' + encodedUrl + '&_=' + Date.now();
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

// === Corrigir FIPE (admin only) =============================================
// Permite o admin escolher manualmente a versão correta da FIPE quando o
// auto-match errou. Salva no /api/fipe/override com 1.0 de confiança — todos
// os clientes passam a ver o valor certo a partir do próximo carregamento.

async function openFipeFix(advertisementId) {
  var token = localStorage.getItem('lp_admin_token');
  if (!token) return showToast('Sessão admin não encontrada — entre em /admin', 'error');
  var v = (currentVehicles || []).find(function(x){ return x.id === advertisementId; }) || currentVehicle;
  if (!v) return;
  window.__fipeFixVehicle = v;

  var modal = document.getElementById('modal-fipe-fix');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-fipe-fix';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)';
    modal.innerHTML =
      '<div style="background:#12152a;border:1px solid rgba(255,255,255,0.08);border-radius:14px;max-width:560px;width:100%;max-height:85vh;overflow:hidden;display:flex;flex-direction:column">' +
        '<div style="padding:18px 20px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;gap:12px">' +
          '<div><div style="font-weight:700;color:#fff;font-size:1.05rem"><i class="fas fa-wand-magic-sparkles" style="color:#fdcb6e"></i> Corrigir FIPE</div>' +
          '<div id="ffix-sub" style="color:#8892b0;font-size:0.78rem;margin-top:3px"></div></div>' +
          '<button onclick="closeFipeFix()" style="background:transparent;border:none;color:#8892b0;font-size:1.4rem;cursor:pointer">×</button>' +
        '</div>' +
        '<div id="ffix-list" style="flex:1;overflow-y:auto;padding:8px"></div>' +
        '<div id="ffix-status" style="padding:10px 20px;font-size:0.82rem;border-top:1px solid rgba(255,255,255,0.04);min-height:18px"></div>' +
      '</div>';
    document.body.appendChild(modal);
  }

  var vehicle = v.vehicle;
  document.getElementById('ffix-sub').textContent = (vehicle.brand_name||'') + ' ' + (vehicle.model_name||'') + ' — ' + (vehicle.model_year||'') + (vehicle.version_name?(' · '+vehicle.version_name):'');
  document.getElementById('ffix-status').textContent = '';
  document.getElementById('ffix-list').innerHTML = '<div style="text-align:center;color:#8892b0;padding:30px"><i class="fas fa-spinner fa-spin"></i> Buscando versões na FIPE…</div>';

  var ctrl = new AbortController();
  var timer = setTimeout(function(){ ctrl.abort(); }, 40000);
  try {
    var url = '/api/fipe/versions?brand=' + encodeURIComponent(vehicle.brand_name) +
              '&model=' + encodeURIComponent(vehicle.model_name) +
              '&year=' + encodeURIComponent(vehicle.model_year) +
              '&version=' + encodeURIComponent(vehicle.version_name || '');
    var res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    var raw = await res.text();
    var data;
    try { data = JSON.parse(raw); } catch (_) { throw new Error('Servidor respondeu HTTP ' + res.status); }
    if (!data.success || !data.data || data.data.length === 0) {
      document.getElementById('ffix-list').innerHTML = '<div style="text-align:center;color:#ff7675;padding:30px">Nenhuma versão encontrada<div style="font-size:0.78rem;color:#8892b0;margin-top:6px">' + (data.error||'') + '</div></div>';
      return;
    }
    window.__fipeFixVersions = data.data;
    var html = '';
    data.data.forEach(function(ver, i){
      html += '<div onclick="applyFipeFix(' + i + ')" style="padding:12px;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px">';
      html += '<div style="flex:1;min-width:0"><div style="font-size:0.88rem;color:#fff">' + ver.modelName + '</div><div style="font-size:0.7rem;color:#8892b0;margin-top:2px">' + (ver.fuel||'') + ' • ' + ver.year + '</div></div>';
      html += '<div style="font-size:1rem;font-weight:700;color:#fdcb6e;white-space:nowrap">' + formatCurrency(ver.value) + '</div>';
      html += '</div>';
    });
    document.getElementById('ffix-list').innerHTML = html;
  } catch (e) {
    clearTimeout(timer);
    document.getElementById('ffix-list').innerHTML = '<div style="text-align:center;color:#ff7675;padding:30px">' + (e.name === 'AbortError' ? 'FIPE demorou demais. Tente de novo.' : 'Erro: ' + e.message) + '</div>';
  }
}

function closeFipeFix() {
  var m = document.getElementById('modal-fipe-fix');
  if (m) m.remove();
}

async function applyFipeFix(index) {
  var ver = (window.__fipeFixVersions || [])[index];
  var v = window.__fipeFixVehicle;
  if (!ver || !v) return;
  var status = document.getElementById('ffix-status');
  status.style.color = '#fdcb6e';
  status.textContent = 'Salvando…';
  try {
    var res = await fetch('/api/fipe/override', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + localStorage.getItem('lp_admin_token')
      },
      body: JSON.stringify({
        brand: v.vehicle.brand_name,
        model: v.vehicle.model_name,
        version: v.vehicle.version_name || '',
        year: v.vehicle.model_year,
        fipeValue: ver.value,
        fipeModel: ver.modelName,
        fipeCode: ver.fipeCode,
        reference: ver.reference
      })
    });
    var data = await res.json();
    if (data.success) {
      status.style.color = '#00b894';
      status.textContent = '✓ FIPE corrigido — recarregando…';
      // Invalida o cache do front pra a análise FIPE redesenhar com o valor novo.
      if (window.fipeCache) delete window.fipeCache[v.id];
      setTimeout(function(){
        closeFipeFix();
        if (currentVehicle && currentVehicle.id === v.id) loadFipeDetail(currentVehicle);
        var card = document.getElementById('fipe-card-' + v.id);
        if (card) card.innerHTML = '';
      }, 900);
    } else {
      status.style.color = '#ff7675';
      status.textContent = '✗ ' + (data.error || 'Erro');
    }
  } catch (e) {
    status.style.color = '#ff7675';
    status.textContent = 'Erro: ' + e.message;
  }
}

// === Nossa Vitrine (estoque próprio do lojista, fotos atualizadas) ===
// IMPORTANTE: estas constantes definem a IDENTIDADE da loja na vitrine
// (independente do LancePrime). Mude aqui pra rebrand simples.
var SHOWROOM_WHATSAPP = '5531992084925'; // (31) 99208-4925 com DDI/DDD
var SHOWROOM_SHOP = 'Multimarcas Premium';
var SHOWROOM_LOCATION = 'Betim/MG'; // localização física da loja (todos os carros ficam aqui)

async function loadShowroom() {
  var grid = document.getElementById('showroom-grid');
  var emptyEl = document.getElementById('showroom-empty');
  if (!grid) return;
  // Links do WhatsApp do header e do footer
  var waUrl = 'https://wa.me/' + SHOWROOM_WHATSAPP + '?text=' +
      encodeURIComponent('Olá! Vi seus carros no site e gostaria de mais informações.');
  var topBtn = document.getElementById('sr-wa-top');
  var footBtn = document.getElementById('sr-wa-foot');
  var heroBtn = document.getElementById('sr-hero-wa');
  if (topBtn) topBtn.href = waUrl;
  if (footBtn) footBtn.href = waUrl;
  if (heroBtn) heroBtn.href = waUrl;
  grid.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
  emptyEl.style.display = 'none';
  try {
    var res = await fetch('/api/my-stock-public');
    var j = await res.json();
    if (!j.success) throw new Error(j.error || 'Falha');
    window.showroomVehicles = j.data || [];
    if (window.showroomVehicles.length === 0) {
      grid.innerHTML = '';
      emptyEl.style.display = 'block';
      return;
    }
    var html = '';
    window.showroomVehicles.forEach(function(v, i){
      html += buildShowroomCardHtml(v, i);
    });
    grid.innerHTML = html;
  } catch(e) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#ff7675;padding:30px">Erro ao carregar: ' + e.message + '</div>';
  }
}

// Detecta o tipo de carroceria pelo modelo. Usado pra gerar o pitch comercial
// adequado ao tipo de veículo. Lista é heurística mas cobre os populares no BR.
function srDetectBodyType(brand, model) {
  var m = ((brand || '') + ' ' + (model || '')).toLowerCase();
  if (/tracker|compass|renegade|kicks|creta|hr-?v|nivus|t-?cross|kuga|ecosport|duster|2008|3008|tiguan|equinox|crv|rav4|q3|q5|x1|x3|x5|tiguan|sw4|hilux sw|fortuner|land cruiser/.test(m)) return 'suv';
  if (/strada|saveiro|hilux|amarok|ranger|s10|frontier|l200|toro|montana|maverick/.test(m)) return 'pickup';
  if (/civic|corolla|virtus|jetta|sentra|cruze|focus|altis|c4 cactus|polo sedan|hb20s|prisma|cobalt|onix sedan|320i|c180|a4|passat|cerato|elantra|fluence|logan|voyage|siena|grand siena|gol sedan|fusion|camry|accord|mazda 3 sedan/.test(m)) return 'sedan';
  if (/civic touring|civic 2\.0|civic si/.test(m)) return 'sedan';
  if (/onix(?! sedan)|hb20(?!s)|polo|gol|fox|fiesta|march|ka(?:[\s$])|punto|palio|fit|i20|i30|golf|fit|yaris(?! sedan)|sandero|argo|mobi|up|kwid|picanto|corsa|celta|clio|march|c3/.test(m)) return 'hatch';
  if (/spin|livina|grand siena tour|caravan|ev family|kangoo|partner|berlingo|kombi/.test(m)) return 'minivan';
  return null;
}

// Gera o pitch comercial do card — linguagem de concessionária premium.
// FOCO: benefício e desejo do CLIENTE FINAL (não argumento de lojista pra
// lojista). Nada de "sem leilão / sem locadora" — isso é pra outro mercado.
function srSalesPitch(v) {
  var body = srDetectBodyType(v.brand, v.model);
  // Pitch base por tipo de carroceria — linguagem aspiracional
  var openers = {
    suv: 'Presença marcante, posição de comando e conforto refinado para encarar qualquer destino com classe.',
    sedan: 'Linhas elegantes, dirigibilidade refinada e habitáculo silencioso. Sofisticação a cada quilômetro.',
    hatch: 'Personalidade urbana, tecnologia embarcada e economia inteligente para o seu dia a dia.',
    pickup: 'Força refinada, capacidade superior e estilo marcante. Performance que combina com seu ritmo.',
    minivan: 'Espaço generoso, versatilidade e conforto para os momentos que mais importam.',
  };
  var pitch = openers[body] || 'Acabamento impecável e condição mecânica excelente. Um veículo pronto para conquistar você.';

  // Acréscimo de impacto se a quilometragem for baixa (exclusividade)
  if (v.km && v.km > 0) {
    if (v.km < 15000) pitch += ' Estado excepcional, com apenas ' + v.km.toLocaleString('pt-BR') + ' km rodados.';
    else if (v.km < 40000) pitch += ' Conservação invejável, baixa rodagem.';
  }
  return pitch;
}

// Simulação simples de financiamento — 60x sem juros (0%) é só pra dar uma
// "âncora" visual. Não é cálculo real, só referência ("ou a partir de R$ X/mês").
// 80% financiado em 60x dá um número honesto pro cliente avaliar.
function srFinancePitch(price) {
  if (!price || price < 5000) return '';
  var financed = price * 0.8; // 20% de entrada
  var monthly = financed / 60;
  // arredonda pra centena pra ficar bonito
  var rounded = Math.round(monthly / 10) * 10;
  return 'ou a partir de R$ ' + rounded.toLocaleString('pt-BR') + '/mês';
}

function buildShowroomCardHtml(v, i) {
  var photos = v.photos || [];
  var cover = photos[0] ? imgUrl(photos[0]) : '';
  var priceTxt = v.price ? formatCurrency(v.price) : 'Sob consulta';
  var financeTxt = srFinancePitch(v.price);
  var name = (v.brand || '') + ' ' + (v.model || '');
  var pitch = srSalesPitch(v);

  // Specs principais — 4 mais relevantes pra mostrar como "pílulas"
  var keySpecs = [];
  if (v.km) keySpecs.push({ icon: 'road', label: v.km.toLocaleString('pt-BR') + ' km' });
  if (v.year) keySpecs.push({ icon: 'calendar', label: v.year });
  if (v.transmission) keySpecs.push({ icon: 'cog', label: v.transmission });
  if (v.fuel) keySpecs.push({ icon: 'gas-pump', label: v.fuel });
  if (v.color) keySpecs.push({ icon: 'palette', label: v.color });

  // Selos de confiança — angulação cliente final, não lojista
  var highlights = [
    { icon: 'shield-halved', text: 'Vistoria cautelar completa' },
    { icon: 'gem', text: 'Garantia de procedência' },
    { icon: 'hand-holding-usd', text: 'Financiamento em até 60x' },
    { icon: 'right-left', text: 'Avaliamos seu carro como entrada' }
  ];

  var html = '<article class="sr-card">';

  // Foto principal com OVERLAY do título (estilo magazine).
  // Tap na foto abre o lightbox direto (gesto natural). Setas e overlay ainda
  // funcionam por causa do stopPropagation no onclick deles.
  html += '<div class="sr-card-img" onclick="openShowroomLightbox(' + i + ', parseInt(document.getElementById(\'sr-img-' + v.id + '\').getAttribute(\'data-idx\'))||0)">';
  if (cover) {
    html += '<img id="sr-img-' + v.id + '" src="' + esc(cover) + '" data-idx="0" alt="' + esc(name) + '" loading="lazy">';
  } else {
    html += '<div class="sr-card-noimg"><i class="fas fa-car"></i></div>';
  }
  // Badges sobre a foto: ano (canto esq), navegação
  if (v.year) html += '<div class="sr-year-badge"><span>' + esc(v.year) + '</span></div>';
  if (photos.length > 1) {
    html += '<button class="sr-nav prev" onclick="event.stopPropagation();srPhotoNav(' + v.id + ',-1)" aria-label="Anterior"><i class="fas fa-chevron-left"></i></button>';
    html += '<button class="sr-nav next" onclick="event.stopPropagation();srPhotoNav(' + v.id + ',1)" aria-label="Próxima"><i class="fas fa-chevron-right"></i></button>';
    html += '<div class="sr-counter" id="sr-counter-' + v.id + '">1 / ' + photos.length + '</div>';
  }
  // Overlay com gradiente + título embaixo da foto
  html += '<div class="sr-card-img-overlay">';
  html += '<div class="sr-card-brand">' + esc(v.brand || '') + '</div>';
  html += '<div class="sr-card-model">' + esc(v.model || '') + '</div>';
  if (v.version) html += '<div class="sr-card-version-overlay">' + esc(v.version) + '</div>';
  html += '</div>';
  html += '</div>';

  // Corpo do card
  html += '<div class="sr-card-body">';

  // Specs em "pílulas"
  if (keySpecs.length) {
    html += '<div class="sr-key-specs">';
    keySpecs.forEach(function(s){
      html += '<div class="sr-key-spec"><i class="fas fa-' + s.icon + '"></i><span>' + esc(s.label) + '</span></div>';
    });
    html += '</div>';
  }

  // Pitch comercial — quote estilizado
  html += '<div class="sr-pitch-block">';
  html += '<i class="fas fa-quote-left sr-quote-icon"></i>';
  html += '<p class="sr-card-pitch">' + esc(pitch) + '</p>';
  html += '</div>';

  // Selos de confiança
  html += '<ul class="sr-highlights">';
  highlights.forEach(function(h){
    html += '<li><i class="fas fa-' + h.icon + '"></i><span>' + esc(h.text) + '</span></li>';
  });
  html += '</ul>';

  // Bloco de preço + simulação de financiamento
  html += '<div class="sr-card-price">';
  html += '<div class="sr-card-price-top">';
  html += '<span class="sr-card-price-label">Preço à vista</span>';
  html += '<span class="sr-card-price-value">' + priceTxt + '</span>';
  html += '</div>';
  if (financeTxt) html += '<div class="sr-card-price-finance"><i class="fas fa-hand-holding-usd"></i> ' + esc(financeTxt) + '</div>';
  html += '</div>';

  // CTAs: 1) Mais informacoes (abre modal de detalhe) 2) Tenho interesse (WhatsApp)
  html += '<button class="sr-cta-info" onclick="openShowroomDetail(' + i + ')"><i class="fas fa-circle-info"></i> Mais informações</button>';
  html += '<div class="sr-card-actions">';
  html += '<button class="sr-cta-primary" onclick="srWhatsApp(' + i + ')"><i class="fab fa-whatsapp"></i> Tenho interesse</button>';
  html += '<button class="sr-cta-secondary" onclick="srCopyDescription(' + i + ',this)" title="Copiar descrição"><i class="fas fa-copy"></i></button>';
  html += '</div>';

  // Localização no rodapé do card
  html += '<div class="sr-card-foot"><i class="fas fa-map-marker-alt"></i> ' + esc(SHOWROOM_LOCATION) + '</div>';

  html += '</div></article>';
  return html;
}

// Navegação simples no carrossel do card da vitrine
function srPhotoNav(vid, delta) {
  var v = (window.showroomVehicles || []).find(function(x){ return x.id === vid; });
  if (!v || !v.photos || v.photos.length < 2) return;
  var imgEl = document.getElementById('sr-img-' + vid);
  if (!imgEl) return;
  var idx = parseInt(imgEl.getAttribute('data-idx') || '0') + delta;
  var total = v.photos.length;
  if (idx < 0) idx = total - 1;
  if (idx >= total) idx = 0;
  imgEl.src = imgUrl(v.photos[idx]);
  imgEl.setAttribute('data-idx', idx);
  var counter = document.getElementById('sr-counter-' + vid);
  if (counter) counter.textContent = (idx + 1) + ' / ' + total;
}

// Mensagem do WhatsApp pré-preenchida
function srWhatsApp(idx) {
  var v = (window.showroomVehicles || [])[idx];
  if (!v) return;
  var priceTxt = v.price ? ' anunciado por R$ ' + v.price.toLocaleString('pt-BR') : '';
  var msg = 'Olá! Tenho interesse no ' + (v.brand || '') + ' ' + (v.model || '') +
            (v.year ? ' ' + v.year : '') + priceTxt + '.';
  var url = 'https://wa.me/' + SHOWROOM_WHATSAPP + '?text=' + encodeURIComponent(msg);
  window.open(url, '_blank');
}

// Texto pronto pra cliente colar em Marketplace, OLX, grupo de WhatsApp, etc.
// Mesmo tom premium do card — sem jargão de "lojista comprando da Dealers".
function srBuildDescription(v) {
  var lines = [];
  lines.push('✨ ' + (v.brand || '') + ' ' + (v.model || '') + (v.year ? ' ' + v.year : ''));
  if (v.version) lines.push(v.version);
  lines.push('');
  lines.push(srSalesPitch(v));
  lines.push('');
  lines.push('🔹 CARACTERÍSTICAS');
  if (v.km) lines.push('• ' + v.km.toLocaleString('pt-BR') + ' km rodados');
  if (v.color) lines.push('• Cor ' + v.color);
  if (v.fuel) lines.push('• ' + v.fuel);
  if (v.transmission) lines.push('• Câmbio ' + v.transmission);
  lines.push('');
  lines.push('🔹 NOSSOS DIFERENCIAIS');
  lines.push('• Vistoria cautelar completa');
  lines.push('• Garantia de procedência');
  lines.push('• Financiamento facilitado em até 60x');
  lines.push('• Avaliamos seu carro como entrada');
  lines.push('• Atendimento personalizado');
  lines.push('');
  if (v.price) {
    lines.push('💎 R$ ' + v.price.toLocaleString('pt-BR') + ' à vista');
    var financed = v.price * 0.8;
    var monthly = Math.round((financed / 60) / 10) * 10;
    if (monthly > 0) lines.push('   ou a partir de R$ ' + monthly.toLocaleString('pt-BR') + '/mês*');
  }
  lines.push('');
  lines.push('📍 ' + SHOWROOM_LOCATION);
  lines.push('');
  lines.push(SHOWROOM_SHOP + ' — Veículos selecionados');
  lines.push('📲 (31) 99208-4925');
  return lines.join('\n');
}

async function srCopyDescription(idx, btn) {
  var v = (window.showroomVehicles || [])[idx];
  if (!v) return;
  var text = srBuildDescription(v);
  try {
    await navigator.clipboard.writeText(text);
    var oldHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-check"></i>';
    btn.style.background = 'rgba(0,184,148,0.2)';
    btn.style.color = '#00b894';
    setTimeout(function(){
      btn.innerHTML = oldHtml;
      btn.style.background = 'rgba(108,92,231,0.18)';
      btn.style.color = '#a29bfe';
    }, 1500);
    showToast('Descrição copiada!', 'success');
  } catch(e) {
    // Fallback antigo (clipboard API pode falhar fora de HTTPS ou no app)
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast('Descrição copiada!', 'success'); }
    catch(_) { alert('Não consegui copiar. Selecione manualmente:\n\n' + text); }
    document.body.removeChild(ta);
  }
}

// ============================================================
// VITRINE: Modal de detalhe + Lightbox de fotos
// CRITICO Android: tudo passive:true; isolacao de gestos via
// touch-action CSS. Sem passive:false em lugar nenhum (foi o que
// travou scroll do site inteiro no Chrome Android).
// ============================================================

// --- Modal de detalhe do veiculo ---
function openShowroomDetail(idx) {
  var v = (window.showroomVehicles || [])[idx];
  if (!v) return;
  window.srDetailIdx = idx;
  document.getElementById('sr-modal-body').innerHTML = buildSrDetailHtml(v, idx);
  document.getElementById('sr-modal').classList.add('active');
  document.body.style.overflow = 'hidden'; // bloqueia scroll de baixo
}

function closeShowroomDetail() {
  document.getElementById('sr-modal').classList.remove('active');
  document.body.style.overflow = '';
}

function buildSrDetailHtml(v, idx) {
  var photos = v.photos || [];
  var cover = photos[0] ? imgUrl(photos[0]) : '';
  var name = (v.brand || '') + ' ' + (v.model || '');
  var priceTxt = v.price ? formatCurrency(v.price) : 'Sob consulta';
  var financeTxt = srFinancePitch(v.price);
  var description = srBuildDescription(v);

  var html = '';
  // Galeria: foto grande + miniaturas
  html += '<div class="sr-md-gallery">';
  if (cover) {
    html += '<img class="sr-md-cover" id="sr-md-cover" src="' + esc(cover) + '" alt="' + esc(name) + '" onclick="openShowroomLightbox(' + idx + ', parseInt(this.getAttribute(\'data-idx\'))||0)" data-idx="0">';
  } else {
    html += '<div class="sr-md-noimg"><i class="fas fa-car"></i></div>';
  }
  if (photos.length > 1) {
    html += '<div class="sr-md-thumbs">';
    photos.forEach(function(p, pi) {
      html += '<img class="sr-md-thumb' + (pi === 0 ? ' active' : '') + '" src="' + esc(imgUrl(p)) + '" data-idx="' + pi + '" onclick="srMdSelect(' + pi + ')" alt="">';
    });
    html += '</div>';
  }
  html += '</div>';

  // Titulo e specs
  html += '<div class="sr-md-content">';
  html += '<div class="sr-md-title">';
  html += '<div class="sr-md-brand">' + esc(v.brand || '') + '</div>';
  html += '<h2 class="sr-md-model">' + esc(v.model || '') + '</h2>';
  if (v.version) html += '<div class="sr-md-version">' + esc(v.version) + '</div>';
  html += '</div>';

  // Specs grid
  html += '<div class="sr-md-specs">';
  if (v.km) html += '<div class="sr-md-spec"><i class="fas fa-road"></i><div><span>Quilometragem</span><strong>' + v.km.toLocaleString('pt-BR') + ' km</strong></div></div>';
  if (v.year) html += '<div class="sr-md-spec"><i class="fas fa-calendar"></i><div><span>Ano</span><strong>' + esc(v.year) + '</strong></div></div>';
  if (v.transmission) html += '<div class="sr-md-spec"><i class="fas fa-cog"></i><div><span>Câmbio</span><strong>' + esc(v.transmission) + '</strong></div></div>';
  if (v.fuel) html += '<div class="sr-md-spec"><i class="fas fa-gas-pump"></i><div><span>Combustível</span><strong>' + esc(v.fuel) + '</strong></div></div>';
  if (v.color) html += '<div class="sr-md-spec"><i class="fas fa-palette"></i><div><span>Cor</span><strong>' + esc(v.color) + '</strong></div></div>';
  html += '<div class="sr-md-spec"><i class="fas fa-map-marker-alt"></i><div><span>Localização</span><strong>' + esc(SHOWROOM_LOCATION) + '</strong></div></div>';
  html += '</div>';

  // Pitch
  html += '<div class="sr-md-pitch">' + esc(srSalesPitch(v)) + '</div>';

  // Diferenciais
  html += '<ul class="sr-md-highlights">';
  html += '<li><i class="fas fa-shield-halved"></i> Vistoria cautelar completa</li>';
  html += '<li><i class="fas fa-gem"></i> Garantia de procedência</li>';
  html += '<li><i class="fas fa-hand-holding-usd"></i> Financiamento em até 60x</li>';
  html += '<li><i class="fas fa-right-left"></i> Avaliamos seu carro como entrada</li>';
  html += '</ul>';

  // Preço
  html += '<div class="sr-md-price">';
  html += '<div class="sr-md-price-row"><span>Preço à vista</span><strong>' + priceTxt + '</strong></div>';
  if (financeTxt) html += '<div class="sr-md-price-finance"><i class="fas fa-hand-holding-usd"></i> ' + esc(financeTxt) + '</div>';
  html += '</div>';

  // CTAs
  html += '<div class="sr-md-actions">';
  html += '<button class="sr-cta-primary" onclick="srWhatsApp(' + idx + ')"><i class="fab fa-whatsapp"></i> Tenho interesse</button>';
  html += '<button class="sr-md-copy" onclick="srCopyDescription(' + idx + ',this)"><i class="fas fa-copy"></i> Copiar descrição</button>';
  html += '</div>';

  html += '</div>';
  return html;
}

function srMdSelect(idx) {
  var v = (window.showroomVehicles || [])[window.srDetailIdx];
  if (!v || !v.photos) return;
  var cover = document.getElementById('sr-md-cover');
  if (cover) {
    cover.src = imgUrl(v.photos[idx]);
    cover.setAttribute('data-idx', idx);
  }
  document.querySelectorAll('.sr-md-thumb').forEach(function(t, ti) {
    t.classList.toggle('active', ti === idx);
  });
}

// --- Lightbox de foto (fullscreen) ---
var srLbPhotos = [];
var srLbIdx = 0;
var srLbBound = false;
var srLbCarIdx = -1;

function openShowroomLightbox(carIdx, startIdx) {
  var v = (window.showroomVehicles || [])[carIdx];
  if (!v || !v.photos || !v.photos.length) return;
  srLbCarIdx = carIdx;
  srLbPhotos = v.photos.map(imgUrl);
  srLbIdx = Math.max(0, Math.min(startIdx || 0, srLbPhotos.length - 1));
  srLbRender();
  document.getElementById('sr-lightbox').classList.add('active');
  document.body.style.overflow = 'hidden';
  if (!srLbBound) { bindSrLbGestures(); srLbBound = true; }
  // preload vizinhas pra evitar piscada
  srLbPhotos.forEach(function(u){ (new Image()).src = u; });
}

function closeShowroomLightbox() {
  var overlay = document.getElementById('sr-lightbox');
  overlay.classList.remove('active');
  overlay.style.background = '';
  var img = document.getElementById('sr-lb-img');
  img.style.transform = '';
  img.style.opacity = '';
  img.style.transition = '';
  // So libera scroll do body se modal de detalhe nao estiver aberto
  if (!document.getElementById('sr-modal').classList.contains('active')) {
    document.body.style.overflow = '';
  }
}

function srLbRender() {
  var img = document.getElementById('sr-lb-img');
  img.src = srLbPhotos[srLbIdx];
  img.style.transform = '';
  img.style.opacity = '';
  document.getElementById('sr-lb-counter').textContent = (srLbIdx + 1) + ' / ' + srLbPhotos.length;
}

function srLbNav(delta) {
  if (srLbPhotos.length < 2) return;
  srLbIdx = (srLbIdx + delta + srLbPhotos.length) % srLbPhotos.length;
  var img = document.getElementById('sr-lb-img');
  // fade rapidinho na troca pra nao parecer corte seco
  img.style.transition = 'opacity 0.15s';
  img.style.opacity = '0.3';
  setTimeout(function() {
    img.src = srLbPhotos[srLbIdx];
    img.style.opacity = '1';
    setTimeout(function() { img.style.transition = ''; }, 160);
  }, 120);
  document.getElementById('sr-lb-counter').textContent = (srLbIdx + 1) + ' / ' + srLbPhotos.length;
}

// Gestos do lightbox: TODOS passive:true. Nao precisamos de preventDefault
// porque o overlay tem touch-action:none no CSS — gestos ja vao direto pro JS.
function bindSrLbGestures() {
  var overlay = document.getElementById('sr-lightbox');
  var img = document.getElementById('sr-lb-img');
  var startX = 0, startY = 0, startT = 0, moving = false;

  overlay.addEventListener('touchstart', function(e) {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startT = Date.now();
    moving = true;
    img.style.transition = ''; // desativa transition durante o drag
  }, { passive: true });

  overlay.addEventListener('touchmove', function(e) {
    if (!moving || e.touches.length !== 1) return;
    var dx = e.touches[0].clientX - startX;
    var dy = e.touches[0].clientY - startY;
    if (Math.abs(dy) > Math.abs(dx) && dy > 0) {
      // Arrastar pra BAIXO: feedback visual de fechar
      var op = Math.max(0.2, 1 - dy / 500);
      overlay.style.background = 'rgba(0,0,0,' + (0.95 * op) + ')';
      img.style.transform = 'translateY(' + dy + 'px) scale(' + Math.max(0.85, 1 - dy / 1500) + ')';
      img.style.opacity = String(op);
    } else if (Math.abs(dx) > 15) {
      // Arrastar lateral: feedback de troca
      img.style.transform = 'translateX(' + (dx * 0.4) + 'px)';
      img.style.opacity = String(Math.max(0.5, 1 - Math.abs(dx) / 500));
    }
  }, { passive: true });

  overlay.addEventListener('touchend', function(e) {
    if (!moving) return;
    moving = false;
    var t = e.changedTouches[0];
    var dx = t.clientX - startX;
    var dy = t.clientY - startY;
    var elapsed = Date.now() - startT;
    overlay.style.background = '';
    img.style.transition = 'transform 0.25s ease, opacity 0.25s ease';

    // Swipe pra baixo: fecha
    if (dy > 110 && dy > Math.abs(dx)) {
      closeShowroomLightbox();
      return;
    }
    // Swipe lateral: troca foto
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      srLbNav(dx < 0 ? 1 : -1);
      return;
    }
    // Tap (sem arrastar): se for nas laterais, troca; senao no-op
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && elapsed < 280) {
      var rect = overlay.getBoundingClientRect();
      var x = t.clientX - rect.left;
      var third = rect.width / 3;
      if (x < third) srLbNav(-1);
      else if (x > rect.width - third) srLbNav(1);
      // tap no meio = no-op (botao X fecha)
    }
    // Resetar posicao
    img.style.transform = '';
    img.style.opacity = '';
    setTimeout(function() { img.style.transition = ''; }, 280);
  }, { passive: true });
}

// Tecla Esc fecha lightbox/modal
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  if (document.getElementById('sr-lightbox') && document.getElementById('sr-lightbox').classList.contains('active')) {
    closeShowroomLightbox();
  } else if (document.getElementById('sr-modal') && document.getElementById('sr-modal').classList.contains('active')) {
    closeShowroomDetail();
  }
  if (e.key === 'ArrowLeft' && document.getElementById('sr-lightbox').classList.contains('active')) srLbNav(-1);
  if (e.key === 'ArrowRight' && document.getElementById('sr-lightbox').classList.contains('active')) srLbNav(1);
});

// === Botao "voltar ao topo" ===
// Aparece a partir de 400px de scroll. Listener passive:true (CRITICO Android,
// senao volta o bug de scroll travado). Usa requestAnimationFrame pra evitar
// trabalho a cada scroll event (passa de 60+ disparos/seg pra ~60 ticks ja com a
// ultima posicao).
function scrollToTop() {
  try { window.scrollTo({ top: 0, behavior: 'smooth' }); }
  catch (e) { window.scrollTo(0, 0); } // Safari antigo sem options
}
(function() {
  var btn = document.getElementById('btn-top');
  if (!btn) return;
  var ticking = false;
  function update() {
    var y = window.scrollY || document.documentElement.scrollTop || 0;
    btn.classList.toggle('visible', y > 400);
    ticking = false;
  }
  window.addEventListener('scroll', function() {
    if (!ticking) { requestAnimationFrame(update); ticking = true; }
  }, { passive: true });
  update();
})();
