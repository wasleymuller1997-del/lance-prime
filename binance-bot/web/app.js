const $ = (sel) => document.querySelector(sel);
let token = localStorage.getItem('bot-token') || '';
let paused = false;

const fmtUSDT = (v) => `${v >= 0 ? '' : '-'}$${Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtSigned = (v) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function fmtDuration(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  return `${h}h${String(min % 60).padStart(2, '0')}`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    $('#token-overlay').hidden = false;
    throw new Error('não autorizado');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function renderStatus(s) {
  paused = s.paused;
  $('#mode-chip').textContent = s.mode.toUpperCase();
  $('#mode-chip').classList.toggle('testnet', s.mode === 'testnet');
  $('#balance').textContent = fmtUSDT(s.balance) + ' USDT';
  const day = $('#day-pnl');
  day.textContent = `hoje: ${fmtSigned(s.dayPnl)} USDT`;
  day.className = `day-pnl ${s.dayPnl >= 0 ? 'gain' : 'loss'}`;

  const btn = $('#pause-btn');
  btn.hidden = false;
  btn.textContent = paused ? '▶ Retomar' : '⏸ Pausar';
  btn.classList.toggle('active', paused);
  $('#paused-banner').hidden = !paused;

  const box = $('#positions');
  box.innerHTML = '';
  $('#no-positions').hidden = s.positions.length > 0;
  for (const p of s.positions) {
    const gain = p.pnl >= 0;
    const card = document.createElement('div');
    card.className = 'pos-card';
    card.innerHTML = `
      <div class="pos-head">
        <div>
          <span class="pos-symbol">${p.symbol.replace('USDT', '')}<small>/USDT</small></span>
          <span class="side ${p.side}">${p.side === 'long' ? 'LONG' : 'SHORT'}</span>
        </div>
        <div class="pos-pnl">
          <div class="value ${gain ? 'gain' : 'loss'}">${fmtSigned(p.pnl)} USDT</div>
          <div class="pct ${gain ? 'gain' : 'loss'}">${fmtSigned(p.pnlPct)}% na margem</div>
        </div>
      </div>
      <div class="pos-grid">
        <div class="cell"><div class="k">Entrada</div><div class="v">${p.entryPrice}</div></div>
        <div class="cell"><div class="k">Agora</div><div class="v">${p.markPrice}</div></div>
        <div class="cell"><div class="k">Tempo</div><div class="v">${fmtDuration(Date.now() - p.openedAt)}</div></div>
        <div class="cell"><div class="k">Stop</div><div class="v loss">${p.sl ?? '—'}</div></div>
        <div class="cell"><div class="k">Alvo</div><div class="v gain">${p.tp ?? '—'}</div></div>
        <div class="cell"><div class="k">Qtd</div><div class="v">${p.qty}</div></div>
      </div>
      ${p.unprotected ? '<div class="unprotected-tag">⚠️ Sem stop na corretora — o robô está tentando proteger</div>' : ''}
      <button class="close-btn" data-symbol="${p.symbol}">💰 Encerrar agora a mercado</button>
    `;
    card.querySelector('.close-btn').addEventListener('click', onClose);
    box.appendChild(card);
  }
  $('#updated').textContent = `Atualizado às ${new Date(s.updatedAt).toLocaleTimeString('pt-BR')} · ${s.interval} · alavancagem ${s.leverage}x`;
}

function renderTrades(data) {
  const box = $('#trades');
  box.innerHTML = '';
  $('#no-trades').hidden = data.trades.length > 0;
  for (const t of data.trades.slice(0, 15)) {
    const pnl = parseFloat(t.pnl_liquido ?? '');
    const hasPnl = Number.isFinite(pnl);
    const row = document.createElement('div');
    row.className = 'trade-row';
    row.innerHTML = `
      <div class="trade-info">
        <div><strong>${(t.simbolo || '').replace('USDT', '')}</strong> ${(t.lado || '').toUpperCase()} <span class="trade-meta">· ${t.motivo || t.evento || ''}</span></div>
        <div class="trade-meta">${t.data ? new Date(t.data).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''} · entrada ${t.entrada}</div>
      </div>
      <div class="trade-pnl ${hasPnl ? (pnl >= 0 ? 'gain' : 'loss') : ''}">${hasPnl ? fmtSigned(pnl) : '—'}</div>
    `;
    box.appendChild(row);
  }
}

async function onClose(ev) {
  const symbol = ev.currentTarget.dataset.symbol;
  if (!confirm(`Encerrar a posição de ${symbol} AGORA a mercado?`)) return;
  ev.currentTarget.disabled = true;
  ev.currentTarget.textContent = 'Encerrando…';
  try {
    await api('/api/close', { method: 'POST', body: JSON.stringify({ symbol }) });
    await refresh();
  } catch (err) {
    alert(`Não consegui encerrar: ${err.message}`);
    ev.currentTarget.disabled = false;
    ev.currentTarget.textContent = '💰 Encerrar agora a mercado';
  }
}

$('#pause-btn').addEventListener('click', async () => {
  const acao = paused ? 'resume' : 'pause';
  if (!paused && !confirm('Pausar novas entradas? Posições abertas continuam protegidas pelo stop/alvo.')) return;
  try {
    await api(`/api/${acao}`, { method: 'POST' });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

$('#token-save').addEventListener('click', () => {
  token = $('#token-input').value.trim();
  localStorage.setItem('bot-token', token);
  $('#token-overlay').hidden = true;
  refresh();
});

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [s, t] = await Promise.all([api('/api/status'), api('/api/trades')]);
    renderStatus(s);
    renderTrades(t);
    $('#offline-banner').hidden = true;
  } catch (err) {
    if (err.message !== 'não autorizado') $('#offline-banner').hidden = false;
  } finally {
    refreshing = false;
  }
}

refresh();
setInterval(refresh, 8000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
