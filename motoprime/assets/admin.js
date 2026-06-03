/* =====================================================================
 * MotoPrime — lógica do painel admin
 * Tudo via MotoStore. Aqui mora o que é EXCLUSIVO do dono da agência:
 * preço de compra, custos e lucro. A fórmula é:
 *        Venda (preço final) − Compra − Custos = Lucro
 * ===================================================================== */
(function () {
  var C = window.MP_CONFIG, fmt = window.MP.fmt, fmtKm = window.MP.fmtKm, Store = window.MotoStore;
  var editingId = null; // moto aberta no drawer (null = nova)
  var drawerPhotos = []; // fotos da moto sendo editada (data-URLs ou URLs)

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

    var rows = list.map(function (m) {
      var p = Store.profit(m), neg = p < 0;
      return '<div class="sum-row">' +
        '<img class="sum-ph" src="' + photoOf(m) + '" alt="">' +
        '<div class="sum-main">' +
        '<div class="sum-name">' + esc(m.brand + ' ' + m.model) + '</div>' +
        '<div class="sum-meta">' + (m.year ? '<span>' + esc(String(m.year)) + '</span>' : '') +
        '<span class="sum-dot ' + m.status + '">' + statusLabel(m.status) + '</span></div>' +
        '</div>' +
        '<div class="sum-nums">' +
        '<div class="sum-sale">' + fmt(m.salePrice) + '</div>' +
        '<div class="sum-profit ' + (neg ? 'neg' : 'pos') + '">' + (neg ? '' : '+') + fmt(p) + '</div>' +
        '</div></div>';
    }).join('');
    document.getElementById('d-list').innerHTML =
      rows || '<div class="empty" style="padding:14px">Nenhuma moto cadastrada.</div>';
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
    if (!list.length) { grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Nenhuma moto. Clique em <b>Novo veículo</b> pra começar.</div>'; return; }
    grid.innerHTML = list.map(function (m) {
      var p = Store.profit(m), neg = p < 0;
      var vs = (m.salePrice > 0 && m.refPrice > 0) ? Math.round((m.salePrice - m.refPrice) / m.refPrice * 100) : null;
      return '<div class="stk">' +
        '<div class="ph"><img src="' + photoOf(m) + '" alt=""></div>' +
        '<div class="b">' +
        '<div class="t">' + m.brand + ' ' + m.model + '</div>' +
        '<div class="s">' + [m.year, fmtKm(m.km), m.cc ? m.cc + 'cc' : ''].filter(Boolean).join(' · ') + ' · <span class="stk-st ' + m.status + '">' + statusLabel(m.status) + '</span></div>' +
        '<div class="fin">' +
        '<div class="cell"><small>Venda</small><b style="color:var(--accent)">' + fmt(m.salePrice) + '</b></div>' +
        '<div class="cell"><small>FIPE</small><b style="color:#aab4d0">' + (m.refPrice ? fmt(m.refPrice) : '—') + '</b></div>' +
        '<div class="cell"><small>Custos</small><b style="color:var(--warn)">' + fmt(Store.totalCosts(m)) + '</b></div>' +
        '<div class="cell"><small>Lucro potencial</small><b style="color:' + (neg ? 'var(--bad)' : 'var(--good)') + '">' + fmt(p) + '</b></div>' +
        '</div>' +
        (vs !== null ? '<div class="stk-vs">' + (vs >= 0 ? '+' + vs + '% acima da FIPE' : Math.abs(vs) + '% abaixo da FIPE') + '</div>' : '') +
        '<div class="act">' +
        '<button class="edit" onclick="MPAdmin.openForm(\'' + m.id + '\')"><i class="fas fa-pen"></i> Gerenciar</button>' +
        '<button class="del" onclick="MPAdmin.removeMoto(\'' + m.id + '\')"><i class="fas fa-trash"></i></button>' +
        '</div></div></div>';
    }).join('');
  }

  /* ---------------- Drawer: criar / editar ---------------- */
  function openForm(id) {
    editingId = id || null;
    var m = id ? Store.get(id) : { type: 'Moto', brand: '', model: '', year: '', km: 0, color: '', cc: 0, fuel: 'Gasolina', start: 'Elétrica', plate: '', buyPrice: 0, salePrice: 0, refPrice: 0, status: 'disponivel', highlight: false, photos: [], notes: '', costs: [] };
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
    drawerPhotos = (m.photos || []).slice();
    var pane = document.getElementById('drawer-pane');
    pane.innerHTML =
      '<h2>' + (isEdit ? '<span><i class="fas fa-motorcycle" style="color:var(--primary)"></i> ' + m.brand + ' ' + m.model + '</span>' : '<span><i class="fas fa-plus"></i> Novo veículo</span>') +
      '<button class="x" onclick="MPAdmin.closeForm()"><i class="fas fa-xmark"></i></button></h2>' +

      // dados
      '<div class="field"><label>Tipo</label><select id="f-type">' +
      '<option value="Moto"' + (m.type === 'Carro' ? '' : ' selected') + '>Moto</option>' +
      '<option value="Carro"' + (m.type === 'Carro' ? ' selected' : '') + '>Carro</option></select></div>' +
      '<div class="row2"><div class="field"><label>Marca</label><input id="f-brand" value="' + esc(m.brand) + '" placeholder="Honda"></div>' +
      '<div class="field"><label>Modelo</label><input id="f-model" value="' + esc(m.model) + '" placeholder="CB 500F"></div></div>' +
      '<div class="row3"><div class="field"><label>Ano</label><input id="f-year" value="' + esc(m.year) + '" placeholder="2023"></div>' +
      '<div class="field"><label>KM</label><input id="f-km" type="number" value="' + (m.km || 0) + '"></div>' +
      '<div class="field"><label>Cilindrada (cc)</label><input id="f-cc" type="number" value="' + (m.cc || 0) + '"></div></div>' +
      '<div class="row3"><div class="field"><label>Cor</label><input id="f-color" value="' + esc(m.color) + '" placeholder="Vermelha"></div>' +
      '<div class="field"><label>Combustível</label><input id="f-fuel" value="' + esc(m.fuel) + '"></div>' +
      '<div class="field"><label>Partida</label><input id="f-start" value="' + esc(m.start) + '"></div></div>' +
      '<div class="field"><label>Fotos da moto</label>' +
      '<div id="photo-thumbs" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(82px,1fr));gap:8px;margin-bottom:10px"></div>' +
      '<label class="mini-btn" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><i class="fas fa-camera"></i> Adicionar fotos' +
      '<input id="photo-file" type="file" accept="image/*" multiple style="display:none" onchange="MPAdmin.addPhotoFiles(this)"></label>' +
      '<div style="display:flex;gap:6px;margin-top:10px">' +
      '<input id="photo-url" placeholder="ou cole uma URL de imagem" style="flex:1;background:var(--bg);border:1px solid var(--line);color:var(--txt);border-radius:9px;padding:9px 11px;font-size:.82rem">' +
      '<button class="btn ghost" style="padding:9px 14px" onclick="MPAdmin.addPhotoUrl()">Add</button></div></div>' +
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
    renderThumbs();
    recalc();
  }

  /* ---------------- Fotos: upload + otimização ---------------- */
  function renderThumbs() {
    var el = document.getElementById('photo-thumbs');
    if (!el) return;
    if (!drawerPhotos.length) {
      el.innerHTML = '<div style="grid-column:1/-1;color:var(--muted);font-size:.78rem;padding:4px 0">Nenhuma foto. A primeira vira a capa do anúncio.</div>';
      return;
    }
    el.innerHTML = drawerPhotos.map(function (p, i) {
      return '<div style="position:relative;aspect-ratio:1;border-radius:8px;overflow:hidden;border:1px solid ' + (i === 0 ? 'var(--primary)' : 'var(--line)') + '">' +
        (i === 0
          ? '<span style="position:absolute;top:3px;left:3px;z-index:1;background:var(--grad);color:#0a0a0a;font-size:.55rem;font-weight:800;padding:2px 6px;border-radius:5px"><i class="fas fa-star"></i> CAPA</span>'
          : '<span style="position:absolute;bottom:3px;left:3px;z-index:1;background:rgba(0,0,0,.6);color:#fff;font-size:.52rem;font-weight:700;padding:2px 6px;border-radius:5px;pointer-events:none">tocar p/ capa</span>') +
        '<img src="' + p + '" onclick="MPAdmin.setCover(' + i + ')" title="Definir como capa" style="width:100%;height:100%;object-fit:cover;cursor:pointer">' +
        '<button title="Remover" onclick="MPAdmin.removePhoto(' + i + ')" style="position:absolute;top:3px;right:3px;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.65);border:none;color:#fff;font-size:.8rem;cursor:pointer;line-height:1">&times;</button>' +
        '</div>';
    }).join('');
  }
  /* tocar numa foto a define como capa (vai pro começo). */
  function setCover(i) {
    if (i <= 0 || i >= drawerPhotos.length) return;
    var x = drawerPhotos.splice(i, 1)[0];
    drawerPhotos.unshift(x);
    renderThumbs();
  }
  /* Reduz a imagem (máx 1100px, JPEG ~0.82) antes de guardar — evita estourar
     o localStorage e deixa o site leve. */
  function compress(src, cb) {
    var img = new Image();
    img.onload = function () {
      var max = 1100, w = img.width, h = img.height;
      if (w > max || h > max) { if (w > h) { h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; } }
      try {
        var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        cb(cv.toDataURL('image/jpeg', 0.82));
      } catch (e) { cb(src); }
    };
    img.onerror = function () { cb(src); };
    img.src = src;
  }
  function addPhotoFiles(input) {
    Array.prototype.slice.call(input.files || []).forEach(function (file) {
      if (!/^image\//.test(file.type)) return;
      var reader = new FileReader();
      reader.onload = function (e) { compress(e.target.result, function (durl) { drawerPhotos.push(durl); renderThumbs(); }); };
      reader.readAsDataURL(file);
    });
    input.value = '';
  }
  function addPhotoUrl() {
    var inp = document.getElementById('photo-url'); if (!inp) return;
    var u = inp.value.trim();
    if (u) { drawerPhotos.push(u); inp.value = ''; renderThumbs(); }
  }
  function removePhoto(i) { drawerPhotos.splice(i, 1); renderThumbs(); }

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
      type: val('f-type') || 'Moto',
      brand: val('f-brand'), model: val('f-model'), year: val('f-year'),
      km: num('f-km'), cc: num('f-cc'), color: val('f-color'),
      fuel: val('f-fuel'), start: val('f-start'),
      buyPrice: num('f-buy'), salePrice: num('f-sale'), refPrice: num('f-ref'),
      status: val('f-status'), highlight: document.getElementById('f-hl').checked,
      notes: val('f-notes'),
      photos: drawerPhotos.slice()
    };
  }
  function saveMoto() {
    var data = collectForm();
    if (!data.brand || !data.model) { alert('Informe pelo menos marca e modelo.'); return; }
    try {
      if (editingId) { Store.update(editingId, data); closeForm(); }
      else {
        var m = Store.add(data);
        editingId = m.id;            // mantém aberto pra já poder lançar custos
        renderDrawer(Store.get(m.id));
      }
    } catch (e) {
      alert('Não foi possível salvar — provavelmente fotos demais para o armazenamento do navegador. Remova algumas fotos e tente de novo.');
      return;
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
    recalc: recalc, resetData: resetData,
    addPhotoFiles: addPhotoFiles, addPhotoUrl: addPhotoUrl, removePhoto: removePhoto, setCover: setCover
  };

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeForm(); });
  document.addEventListener('DOMContentLoaded', function () { applyBrand(); renderDash(); });
})();
