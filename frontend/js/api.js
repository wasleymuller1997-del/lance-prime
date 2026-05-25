const API_URL = window.location.hostname === 'localhost' ? 'http://localhost:3001/api' : '/api';

function authHeaders() {
  var token = localStorage.getItem('lp_token');
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return headers;
}

const api = {
  async getEvents() {
    const res = await fetch(`${API_URL}/events`);
    return res.json();
  },

  async getEventVehicles(eventId) {
    const res = await fetch(`${API_URL}/events/${eventId}/vehicles`);
    return res.json();
  },

  async getEventDetails(eventId) {
    const res = await fetch(`${API_URL}/events/${eventId}`);
    return res.json();
  },

  async getOffers(advertisementId) {
    const res = await fetch(`${API_URL}/vehicles/${advertisementId}/offers`);
    return res.json();
  },

  async placeBid(advertisementId, value, brand, model, vehicleData) {
    const res = await fetch(`${API_URL}/vehicles/${advertisementId}/bid`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ value, brand: brand || '', model: model || '', vehicleData: vehicleData || null })
    });
    return res.json();
  },

  async placeAutoBid(advertisementId, maxValue, tiebreaker = false, brand, model, vehicleData) {
    const res = await fetch(`${API_URL}/vehicles/${advertisementId}/auto-bid`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ maxValue, tiebreaker, brand: brand || '', model: model || '', vehicleData: vehicleData || null })
    });
    return res.json();
  },

  async buyNow(advertisementId, value, vehicleData) {
    const res = await fetch(`${API_URL}/vehicles/${advertisementId}/buy-now`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ value, vehicleData: vehicleData || null })
    });
    return res.json();
  },

  async getFipeValue(brand, model, version, year) {
    // Sempre usar o backend para evitar problemas de CORS
    try {
      const params = new URLSearchParams({ brand, model, version: version || '', year });
      const res = await fetch(`${API_URL}/fipe/valor?${params}`);
      return res.json();
    } catch(e) {
      console.error('Erro ao consultar FIPE:', e);
      return { success: false, data: null };
    }
  },

  async _fipeFromBrowser(brand, model, version, year) {
    const FIPE = 'https://veiculos.fipe.org.br/api/veiculos';
    const headers = {'Content-Type':'application/x-www-form-urlencoded','Referer':'https://veiculos.fipe.org.br'};
    function norm(s) { return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim(); }
    function sim(a,b) {
      var na=norm(a),nb=norm(b);
      if(na===nb) return 1;
      if(na.includes(nb)||nb.includes(na)) return 0.95;
      var er=/\b(\d\.\d)\b/,ea=na.match(er),eb=nb.match(er);
      if(ea&&eb&&ea[1]!==eb[1]) return 0.1;
      var ws=nb.split(/\s+/).filter(w=>w.length>1);
      var wt=na.split(/\s+/).filter(w=>w.length>1);
      var m=0;
      for(var w of ws){if(wt.some(t=>t===w||t.includes(w)||w.includes(t)))m++;}
      return ws.length>0?m/ws.length:0;
    }
    async function fipePost(endpoint, body) {
      var res = await fetch(FIPE+'/'+endpoint, {method:'POST',headers,body});
      return res.json();
    }
    // Tabela referencia
    var tabelas = await fipePost('ConsultarTabelaDeReferencia','');
    var tabela = tabelas[0].Codigo;
    // Marcas
    var marcas = await fipePost('ConsultarMarcas','codigoTipoVeiculo=1&codigoTabelaReferencia='+tabela);
    var brandNorm = norm(brand);
    var marca = marcas.find(m=>norm(m.Label)===brandNorm) || marcas.find(m=>norm(m.Label).includes(brandNorm)||brandNorm.includes(norm(m.Label)));
    if(!marca) return {success:false,data:null};
    // Modelos
    var modelosData = await fipePost('ConsultarModelos','codigoTipoVeiculo=1&codigoTabelaReferencia='+tabela+'&codigoMarca='+marca.Value);
    var modelos = modelosData.Modelos;
    var searchStr = (model+' '+(version||'')).trim();
    var modelNorm = norm(model);
    var candidates = [];
    for(var m of modelos){if(!norm(m.Label).includes(modelNorm))continue;var s=sim(m.Label,searchStr);if(s>=0.3)candidates.push({model:m,score:s});}
    if(candidates.length===0){for(var m2 of modelos){var s2=sim(m2.Label,searchStr);if(s2>=0.3)candidates.push({model:m2,score:s2});}}
    candidates.sort((a,b)=>b.score-a.score);
    for(var c of candidates){
      var anos = await fipePost('ConsultarAnoModelo','codigoTipoVeiculo=1&codigoTabelaReferencia='+tabela+'&codigoMarca='+marca.Value+'&codigoModelo='+c.model.Value);
      var yearStr = String(year);
      var ano = anos.find(a=>a.Value.startsWith(yearStr+'-'))||anos.find(a=>a.Label.includes(yearStr));
      if(!ano) continue;
      var parts = ano.Value.split('-');
      var data = await fipePost('ConsultarValorComTodosParametros','codigoTipoVeiculo=1&codigoTabelaReferencia='+tabela+'&codigoMarca='+marca.Value+'&codigoModelo='+c.model.Value+'&anoModelo='+parts[0]+'&codigoTipoCombustivel='+parts[1]+'&tipoConsulta=tradicional');
      var valorNum = parseFloat(data.Valor.replace('R$ ','').replace(/\./g,'').replace(',','.'));
      return {success:true,data:{value:valorNum,model:data.Modelo,year:data.AnoModelo,reference:data.MesReferencia,fipeCode:data.CodigoFipe,matchScore:c.score.toFixed(2)}};
    }
    return {success:false,data:null};
  },

  async toggleFavorite(advertisementId) {
    const res = await fetch(`${API_URL}/vehicles/${advertisementId}/favorite`, {
      method: 'POST'
    });
    return res.json();
  },

  async getMyOffers() {
    const res = await fetch(`${API_URL}/my-offers`);
    return res.json();
  },

  async generatePix(valor, advertisementId, vehicleInfo, tipo) {
    const res = await fetch(`${API_URL}/pix/gerar`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ valor, tipo: tipo || 'sinal', advertisementId: advertisementId || null, vehicleInfo: vehicleInfo || '' })
    });
    return res.json();
  },

  async getPixStatus(txid) {
    const res = await fetch(`${API_URL}/pix/status/${encodeURIComponent(txid)}`);
    return res.json();
  }
};
