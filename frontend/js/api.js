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
    try {
      return await this._fipeFromBrowser(brand, model, version, year);
    } catch(e) {
      // Fallback pro backend
      const params = new URLSearchParams({ brand, model, version: version || '', year });
      const res = await fetch(`${API_URL}/fipe/valor?${params}`);
      return res.json();
    }
  },

  async _fipeFromBrowser(brand, model, version, year) {
    const FIPE = 'https://parallelum.com.br/fipe/api/v1';
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
    var marcasRes = await fetch(FIPE+'/carros/marcas');
    var marcas = await marcasRes.json();
    var brandNorm = norm(brand);
    var marca = marcas.find(m=>norm(m.nome)===brandNorm) || marcas.find(m=>norm(m.nome).includes(brandNorm)||brandNorm.includes(norm(m.nome)));
    if(!marca) return {success:false,data:null};
    var modelosRes = await fetch(FIPE+'/carros/marcas/'+marca.codigo+'/modelos');
    var modelosData = await modelosRes.json();
    var modelos = modelosData.modelos;
    var searchStr = (model+' '+(version||'')).trim();
    var modelNorm = norm(model);
    var candidates = [];
    for(var m of modelos){if(!norm(m.nome).includes(modelNorm))continue;var s=sim(m.nome,searchStr);if(s>=0.3)candidates.push({model:m,score:s});}
    if(candidates.length===0){for(var m2 of modelos){var s2=sim(m2.nome,searchStr);if(s2>=0.3)candidates.push({model:m2,score:s2});}}
    candidates.sort((a,b)=>b.score-a.score);
    for(var c of candidates){
      var anosRes = await fetch(FIPE+'/carros/marcas/'+marca.codigo+'/modelos/'+c.model.codigo+'/anos');
      var anos = await anosRes.json();
      var yearStr = String(year);
      var ano = anos.find(a=>a.codigo.startsWith(yearStr+'-'))||anos.find(a=>a.nome.includes(yearStr));
      if(!ano) continue;
      var valorRes = await fetch(FIPE+'/carros/marcas/'+marca.codigo+'/modelos/'+c.model.codigo+'/anos/'+ano.codigo);
      var data = await valorRes.json();
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
  }
};
