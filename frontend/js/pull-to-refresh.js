// Pull-to-refresh customizado pra PWA instalado (Adicionar à Tela de Início).
// No Safari/Chrome normal o navegador já tem o gesto nativo, então a gente só
// ativa quando o site está rodando em "standalone" (sem barra de navegador).
//
// Funciona assim: a partir do topo (scrollY === 0), arrasta o dedo pra baixo;
// um indicador aparece descendo do topo; se passar do threshold (80px), solta
// e recarrega a página. Antes disso, solta volta sem fazer nada.

(function() {
  var isStandalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  // iOS Safari usa navigator.standalone em vez do display-mode
  if (window.navigator && window.navigator.standalone === true) isStandalone = true;
  if (!isStandalone) return; // navegador normal já tem o gesto nativo

  var THRESHOLD = 80;
  var startY = 0;
  var lastY = 0;
  var pulling = false;
  var indicator = null;

  function ensureIndicator() {
    if (indicator) return indicator;
    indicator = document.createElement('div');
    indicator.id = 'ptr-indicator';
    indicator.style.cssText =
      'position:fixed;top:0;left:0;right:0;height:60px;' +
      'display:flex;align-items:center;justify-content:center;' +
      'z-index:99999;color:#a29bfe;font-size:0.82rem;font-weight:600;' +
      'pointer-events:none;background:rgba(11,13,23,0.95);' +
      'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
      'transform:translateY(-100%);transition:transform 0.18s ease;' +
      'padding-top:env(safe-area-inset-top, 0px)';
    indicator.innerHTML = '<i class="fas fa-arrow-down" style="margin-right:8px"></i><span>Puxe pra atualizar</span>';
    document.body.appendChild(indicator);
    return indicator;
  }

  function setIndicator(distance) {
    var el = ensureIndicator();
    var d = Math.max(0, distance);
    var shown = Math.min(d, 80);
    el.style.transition = 'none';
    el.style.transform = 'translateY(' + (shown - 60) + 'px)';
    if (d >= THRESHOLD) {
      el.innerHTML = '<i class="fas fa-arrow-rotate-right" style="margin-right:8px"></i><span>Solte para atualizar</span>';
      el.style.color = '#00b894';
    } else {
      el.innerHTML = '<i class="fas fa-arrow-down" style="margin-right:8px"></i><span>Puxe pra atualizar</span>';
      el.style.color = '#a29bfe';
    }
  }

  function hideIndicator() {
    if (!indicator) return;
    indicator.style.transition = 'transform 0.22s ease';
    indicator.style.transform = 'translateY(-100%)';
  }

  document.addEventListener('touchstart', function(e) {
    if (window.scrollY > 0) return;
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    lastY = startY;
    pulling = true;
  }, { passive: true });

  document.addEventListener('touchmove', function(e) {
    if (!pulling) return;
    lastY = e.touches[0].clientY;
    var diff = lastY - startY;
    // Se rolou pra baixo (delta negativo) ou já saiu do topo, cancela.
    if (diff <= 0 || window.scrollY > 0) {
      pulling = false;
      hideIndicator();
      return;
    }
    // Resistência: aplica 0.5 de fator pra parecer "elástico" como o iOS.
    if (diff > 8) setIndicator(diff * 0.5);
  }, { passive: true });

  document.addEventListener('touchend', function() {
    if (!pulling) return;
    pulling = false;
    var diff = (lastY - startY) * 0.5;
    if (diff >= THRESHOLD) {
      var el = ensureIndicator();
      el.style.transition = 'transform 0.18s ease';
      el.style.transform = 'translateY(0)';
      el.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:8px"></i><span>Atualizando…</span>';
      el.style.color = '#fdcb6e';
      // location.reload() respeita o Cache-Control no-cache que a gente já manda
      // pros HTMLs — então pega a versão nova do código (JS/CSS) também.
      setTimeout(function() { window.location.reload(); }, 250);
    } else {
      hideIndicator();
    }
  }, { passive: true });

  // Cancela se a janela perder foco no meio do gesto (caso usuário receba ligação).
  document.addEventListener('touchcancel', function() {
    if (!pulling) return;
    pulling = false;
    hideIndicator();
  }, { passive: true });
})();
