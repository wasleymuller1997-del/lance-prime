/* =====================================================================
 * MotoPrime — lógica do painel admin
 * Tudo via MotoStore. Aqui mora o que é EXCLUSIVO do dono da agência:
 * preço de compra, custos e lucro. A fórmula é:
 *        Venda (preço final) − Compra − Custos = Lucro
 * ===================================================================== */
(function () {
  var C = window.MP_CONFIG, fmt = window.MP.fmt, fmtKm = window.MP.fmtKm, Store = window.MotoStore;
  var editingId = null; // moto aberta no drawer (null = nova)

  function applyBrand() {
    var root = document.documentElement.style;
    root.setProperty('--primary', C.colors.primary);
    root.setProperty('--accent', C.colors.accent);
    root.setProperty('--bg', C.colors.bg);
    root.setProperty('--card', C.colors.card);
    document.title = C.brand + ' — Painel';
    window.MP.applyLogo();
  }

  function photoOf(m) {
    var p = (m.photos || [])[0];
    return p && p.trim() ? p : window.MP.placeholder(m.brand + ' ' + m.model);
  }
  function statusLabel(s) { return s === 'reservada' ? 'Reservada' : s === 'vendida' ? 'Vendida' : 'Disponível'; }

  /* ---------------- Navegação ---------------- */
  function show(view, el) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    document.getElementById('view-' + view).classList.add('active');
    document.querySelectorAll('.side nav a').forEach(function (a) { a.classList.remove('active'); });
    if (el) el.classList.add('active');
    document.getElementById('side').classList.remove('show');
    if (view === 'dash') renderDash(); else renderStock();
  }

  /* ---------------- Dashboard ---------------- */
  function renderDash() {
    var list = Store.list();
    var totalSale = 0, totalCosts = 0, totalProfit = 0;
    list.forEach(function (m) {
      totalSale += Number(m.salePrice) || 0;
      totalCosts += Store.totalCosts(m);
      totalProfit += Store.profit(m);
    });
    document.getElementById('d-total').textContent = list.length;
    document.getElementById('d-value').textContent = fmt(totalSale);
    document.getElementById('d-costs').textContent = fmt(totalCosts);
    document.getElementById('d-profit').textContent = fmt(totalProfit);

    var head = '<thead><tr style="text-align:left;color:var(--muted);border-bottom:1px solid var(--line)">' +
      ['Moto', 'Compra', 'Custos', 'Venda', 'Lucro', 'Status'].map(function (h) { return '<th style="padding:10px 8px;font-weight:600">' + h + '</th>'; }).join('') +
      '</tr></thead>';
    var rows = list.map(function (m) {
      var p = Store.profit(m), neg = p < 0;
      return '<tr style="border-bottom:1px solid var(--line)">' +
        '<td style="padding:10px 8px"><b>' + m.brand + ' ' + m.model + '</b><br><small style="color:var(--muted)">' + (m.year || '') + '</small></td>' +
        '<td style="padding:10px 8px;color:#d8b974">' + fmt(m.buyPrice) + '</td>' +
        '<td style="padding:10px 8px;color:var(--warn)">' + fmt(Store.totalCosts(m)) + '</td>' +
        '<td style="padding:10px 8px;color:var(--accent)">' + fmt(m.salePrice) + '</td>' +
        '<td style="padding:10px 8px;font-weight:700;color:' + (neg ? 'var(--bad)' : 'var(--good)') + '">' + fmt(p) + '</td>' +
        '<td style="padding:10px 8px"><span class="badge ' + m.status + '">' + statusLabel(m.status) + '</span></td>' +
        '</tr>';
    }).join('');
    document.getElementById('d-table').innerHTML = head + '<tbody>' +
      (rows || '<tr><td colspan="6" class="empty">Nenhuma moto cadastrada.</td></tr>') + '</tbody>';
  }

  /* ---------------- Estoque ---------------- */
  function renderStock() {
    var list = Store.list();
    var avail = list.filter(function (m) { return m.status === 'disponivel'; }).length;
    var costs = 0, profit = 0;
    list.forEach(function (m) { costs += Store.totalCosts(m); profit += Store.profit(m); });
    document.getElementById('s-total').textContent = list.length;
    document.getElementById('s-avail').textContent = avail;
    document.getElementById('s-costs').textContent = fmt(costs);
    document.getElementById('s-profit').textContent = fmt(profit);

    var grid = document.getElementById('stk-grid');
    if (!list.length) { grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Nenhuma moto. Clique em <b>Nova moto</b> pra começar.</div>'; return; }
    grid.innerHTML = list.map(function (m) {
      var p = Store.profit(m), neg = p < 0;
      return '<div class="stk">' +
        '<div class="ph"><span class="badge st ' + m.status + '">' + statusLabel(m.status) + '</span>' +
        '<img src="' + photoOf(m) + '" alt=""></div>' +
        '<div class="b">' +
        '<div class="t">' + m.brand + ' ' + m.model + '</div>' +
        '<div class="s">' + [m.year, fmtKm(m.km), m.cc ? m.cc + 'cc' : ''].filter(Boolean).join(' · ') + '</div>' +
        '<div class="fin">' +
        '<div class="cell"><small>Venda</small><b style="color:var(--accent)">' + fmt(m.salePrice) + '</b></div>' +
        '<div class="cell"><small>Custos</small><b style="color:var(--warn)">' + fmt(Store.totalCosts(m)) + '</b></div>' +
        '<div class="cell" style="grid-column:1/-1"><small>Lucro potencial</small><b style="color:' + (neg ? 'var(--bad)' : 'var(--good)') + '">' + fmt(p) + '</b></div>' +
        '</div>' +
        '<div class="act">' +
        '<button class="edit" onclick="MPAdmin.openForm(\'' + m.id + '\')"><i class="fas fa-pen"></i> Gerenciar</button>' +
        '<button class="del" onclick="MPAdmin.removeMoto(\'' + m.id + '\')"><i class="fas fa-trash"></i></button>' +
        '</div></div></div>';
    }).join('');
  }

  /* ---------------- Drawer: criar / editar ---------------- */
  function openForm(id) {
    editingId = id || null;
    var m = id ? Store.get(id) : { brand: '', model: '', year: '', km: 0, color: '', cc: 0, fuel: 'Gasolina', start: 'Elétrica', plate: '', buyPrice: 0, salePrice: 0, refPrice: 0, status: 'disponivel', highlight: false, photos: [], notes: '', costs: [] };
    if (id && !m) return;
    renderDrawer(m);
    document.getElementById('drawer').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeForm() {
    document.getElementById('drawer').classList.remove('open');
    document.body.style.overflow = ''; editingId = null;
  }

  function renderDrawer(m) {
    var isEdit = !!editingId;
    var costs = m.costs || [];
    var pane = document.getElementById('drawer-pane');
    pane.innerHTML =
      '<h2>' + (isEdit ? '<span><i class="fas fa-motorcycle" style="color:var(--primary)"></i> ' + m.brand + ' ' + m.model + '</span>' : '<span><i class="fas fa-plus"></i> Nova moto</span>') +
      '<button class="x" onclick="MPAdmin.closeForm()"><i class="fas fa-xmark"></i></button></h2>' +

      // dados
      '<div class="row2"><div class="field"><label>Marca</label><input id="f-brand" value="' + esc(m.brand) + '" placeholder="Honda"></div>' +
      '<div class="field"><label>Modelo</label><input id="f-model" value="' + esc(m.model) + '" placeholder="CB 500F"></div></div>' +
      '<div class="row3"><div class="field"><label>Ano</label><input id="f-year" value="' + esc(m.year) + '" placeholder="2023"></div>' +
      '<div class="field"><label>KM</label><input id="f-km" type="number" value="' + (m.km || 0) + '"></div>' +
      '<div class="field"><label>Cilindrada (cc)</label><input id="f-cc" type="number" value="' + (m.cc || 0) + '"></div></div>' +
      '<div class="row3"><div class="field"><label>Cor</label><input id="f-color" value="' + esc(m.color) + '" placeholder="Vermelha"></div>' +
      '<div class="field"><label>Combustível</label><input id="f-fuel" value="' + esc(m.fuel) + '"></div>' +
      '<div class="field"><label>Partida</label><input id="f-start" value="' + esc(m.start) + '"></div></div>' +
      '<div class="field"><label>Fotos (URLs, uma por linha)</label><textarea id="f-photos" placeholder="https://...jpg">' + esc((m.photos || []).join('\n')) + '</textarea></div>' +
      '<div class="field"><label>Observações (aparece no site)</label><textarea id="f-notes" placeholder="Único dono, IPVA pago, pneus novos...">' + esc(m.notes) + '</textarea></div>' +

      // preços
      '<div class="panel" style="margin:6px 0 16px">' +
      '<div class="row2"><div class="field"><label>Preço de compra <span style="color:#d8b974">(só você vê)</span></label><input id="f-buy" type="number" oninput="MPAdmin.recalc()" value="' + (m.buyPrice || 0) + '"></div>' +
      '<div class="field"><label>Preço final (público)</label><input id="f-sale" type="number" oninput="MPAdmin.recalc()" value="' + (m.salePrice || 0) + '"></div></div>' +
      '<div class="row2"><div class="field"><label>Tabela / referência <span style="color:var(--muted)">(FIPE manual)</span></label><input id="f-ref" type="number" value="' + (m.refPrice || 0) + '"></div>' +
      '<div class="field"><label>Status</label><select id="f-status">' +
      ['disponivel', 'reservada', 'vendida'].map(function (s) { return '<option value="' + s + '"' + (m.status === s ? ' selected' : '') + '>' + statusLabel(s) + '</option>'; }).join('') +
      '</select></div></div>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:.85rem;color:var(--muted);cursor:pointer"><input id="f-hl" type="checkbox"' + (m.highlight ? ' checked' : '') + '> Destacar no site público</label>' +
      '</div>' +

      // SIMULADOR (fórmula)
      '<h3 style="font-size:.95rem;margin:4px 0 4px"><i class="fas fa-chart-line" style="color:var(--good)"></i> Simulador de lucro</h3>' +
      '<div class="formula" id="formula"></div>' +

      // CUSTOS (só quando já existe a moto — precisa de id pra anexar)
      (isEdit
        ? '<h3 style="font-size:.95rem;margin:14px 0 8px;display:flex;justify-content:space-between;align-items:center">' +
          '<span><i class="fas fa-screwdriver-wrench" style="color:var(--warn)"></i> Central de custos</span></h3>' +
          '<div class="row3" style="grid-template-columns:1.1fr 1.4fr .9fr;gap:8px;align-items:end">' +
          '<div class="field" style="margin:0"><label>Categoria</label><select id="c-cat">' +
          ['Frete', 'Revisão', 'Reparo', 'Documentação', 'Estética', 'IPVA', 'Comissão', 'Outros'].map(function (c) { return '<option>' + c + '</option>'; }).join('') +
          '</select></div>' +
          '<div class="field" style="margin:0"><label>Descrição</label><input id="c-desc" placeholder="Ex: Troca de óleo"></div>' +
          '<div class="field" style="margin:0"><label>Valor</label><input id="c-amt" type="number" step="0.01" placeholder="0,00"></div>' +
          '</div>' +
          '<button class="mini-btn" style="margin:10px 0 14px" onclick="MPAdmin.addCost()"><i class="fas fa-plus"></i> Lançar custo</button>' +
          '<div id="cost-list"></div>'
        : '<div class="empty" style="padding:18px;font-size:.82rem">Salve a moto primeiro pra começar a lançar custos.</div>') +

      // ações
      '<div style="display:flex;gap:10px;margin-top:18px">' +
      '<button class="btn" style="flex:1" onclick="MPAdmin.saveMoto()"><i class="fas fa-floppy-disk"></i> ' + (isEdit ? 'Salvar alterações' : 'Cadastrar moto') + '</button>' +
      '<button class="btn ghost" onclick="MPAdmin.closeForm()">Cancelar</button></div>';

    renderCostList(costs);
    recalc();
  }

  function renderCostList(costs) {
    var el = document.getElementById('cost-list');
    if (!el) return;
    if (!costs.length) { el.innerHTML = '<div class="empty" style="padding:14px;font-size:.8rem">Nenhum custo lançado ainda.</div>'; return; }
    el.innerHTML = costs.map(function (c) {
      return '<div class="cost-row"><div class="meta"><b>' + esc(c.category) + '</b>' +
        (c.description ? ' <span style="color:var(--muted)">— ' + esc(c.description) + '</span>' : '') +
        '<br><small>' + (c.date || '') + '</small></div>' +
        '<div style="display:flex;align-items:center"><span class="amt">' + fmt(c.amount) + '</span>' +
        '<button onclick="MPAdmin.removeCost(\'' + c.id + '\')"><i class="fas fa-trash"></i></button></div></div>';
    }).join('');
  }

  /* Recalcula a fórmula Venda − Compra − Custos = Lucro em tempo real. */
  function recalc() {
    var buy = num('f-buy'), sale = num('f-sale');
    var costs = editingId ? Store.totalCosts(Store.get(editingId)) : 0;
    var profit = sale - buy - costs, neg = profit < 0;
    var margin = sale > 0 ? (profit / sale * 100) : 0;
    var f = document.getElementById('formula');
    if (!f) return;
    f.innerHTML =
      '<div class="c venda"><small>Venda</small><b>' + fmt(sale) + '</b><span class="op">−</span></div>' +
      '<div class="c compra"><small>Compra</small><b>' + fmt(buy) + '</b><span class="op">−</span></div>' +
      '<div class="c custos"><small>Custos</small><b>' + fmt(costs) + '</b><span class="op">=</span></div>' +
      '<div class="c lucro' + (neg ? ' neg' : '') + '"><small>Lucro (' + margin.toFixed(0) + '%)</small><b>' + fmt(profit) + '</b></div>';
  }

  /* ---------------- Ações de dados ---------------- */
  function collectForm() {
    return {
      brand: val('f-brand'), model: val('f-model'), year: val('f-year'),
      km: num('f-km'), cc: num('f-cc'), color: val('f-color'),
      fuel: val('f-fuel'), start: val('f-start'),
      buyPrice: num('f-buy'), salePrice: num('f-sale'), refPrice: num('f-ref'),
      status: val('f-status'), highlight: document.getElementById('f-hl').checked,
      notes: val('f-notes'),
      photos: val('f-photos').split('\n').map(function (s) { return s.trim(); }).filter(Boolean)
    };
  }
  function saveMoto() {
    var data = collectForm();
    if (!data.brand || !data.model) { alert('Informe pelo menos marca e modelo.'); return; }
    if (editingId) { Store.update(editingId, data); closeForm(); }
    else {
      var m = Store.add(data);
      editingId = m.id;            // mantém aberto pra já poder lançar custos
      renderDrawer(Store.get(m.id));
    }
    refreshAll();
  }
  function removeMoto(id) {
    if (!confirm('Remover esta moto do estoque? Isso some do site público também.')) return;
    Store.remove(id); refreshAll();
  }
  function addCost() {
    if (!editingId) return;
    var amt = num('c-amt');
    if (!amt) { alert('Informe o valor do custo.'); return; }
    Store.addCost(editingId, { category: val('c-cat'), description: val('c-desc'), amount: amt });
    renderCostList(Store.get(editingId).costs);
    document.getElementById('c-desc').value = ''; document.getElementById('c-amt').value = '';
    recalc(); refreshAll();
  }
  function removeCost(costId) {
    if (!editingId) return;
    Store.removeCost(editingId, costId);
    renderCostList(Store.get(editingId).costs);
    recalc(); refreshAll();
  }
  function resetData() {
    if (!confirm('Restaurar os dados de exemplo? Isso apaga as motos que você cadastrou aqui neste navegador.')) return;
    Store.reset(); refreshAll();
  }

  function refreshAll() {
    if (document.getElementById('view-dash').classList.contains('active')) renderDash();
    else renderStock();
  }

  /* helpers de DOM */
  function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }
  function num(id) { var e = document.getElementById(id); return e ? (parseFloat(e.value) || 0) : 0; }
  function esc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

  window.MPAdmin = {
    show: show, openForm: openForm, closeForm: closeForm, saveMoto: saveMoto,
    removeMoto: removeMoto, addCost: addCost, removeCost: removeCost,
    recalc: recalc, resetData: resetData
  };

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeForm(); });
  document.addEventListener('DOMContentLoaded', function () { applyBrand(); renderDash(); });
})();
