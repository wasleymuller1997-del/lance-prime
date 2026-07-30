const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

class DealersService {
  constructor() {
    this.token = null;
    this.tokenExpiresAt = null;
    this.api = axios.create({
      baseURL: process.env.DEALERS_API_URL,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Origin': process.env.DEALERS_AUDITORIO_ORIGIN,
        'Referer': process.env.DEALERS_AUDITORIO_ORIGIN + '/'
      }
    });
  }

  async login() {
    const deviceToken = crypto.randomUUID();
    const res = await this.api.post('/v1/login', {
      email: process.env.DEALERS_EMAIL,
      password: process.env.DEALERS_PASSWORD,
      whitelabel_origin_id: parseInt(process.env.DEALERS_WHITELABEL_ID)
    }, {
      headers: { 'X-Device-Token': deviceToken }
    });

    this.token = res.data.results.access_token;
    this.tokenExpiresAt = new Date(res.data.results.expires_at);
    this.api.defaults.headers.common['Authorization'] = `Bearer ${this.token}`;
    return res.data.results;
  }

  async ensureAuth() {
    if (!this.token || new Date() >= this.tokenExpiresAt) {
      await this.login();
    }
  }

  async requestWithRetry(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.response && err.response.status === 401) {
        this.token = null;
        await this.login();
        return await fn();
      }
      throw err;
    }
  }

  async getEvents() {
    await this.ensureAuth();
    return this.requestWithRetry(async () => {
      const res = await this.api.get('/v1/publica/lista/eventos');
      return res.data;
    });
  }

  async getEventDetails(eventId) {
    await this.ensureAuth();
    return this.requestWithRetry(async () => {
      const res = await this.api.get(`/v1/auditorio/evento/${eventId}`);
      return res.data.results;
    });
  }

  async getEventVehicles(eventId) {
    await this.ensureAuth();
    const whitelabelId = process.env.DEALERS_WHITELABEL_ID;
    return this.requestWithRetry(async () => {
      const res = await this.api.get(`/v1/auditorio/anuncios/${whitelabelId}/${eventId}`);
      return res.data.results;
    });
  }

  async getOffers(advertisementId) {
    await this.ensureAuth();
    return this.requestWithRetry(async () => {
      const res = await this.api.get(`/v1/auditorio/oferta/${advertisementId}`);
      return res.data.results;
    });
  }

  // TEMPORARIO: sonda varios endpoints pra achar onde estao os lotes da venda direta.
  async _probeEndpoints(eventId) {
    await this.ensureAuth();
    const wl = process.env.DEALERS_WHITELABEL_ID;
    const paths = [
      `/v1/auditorio/anuncios/${wl}/${eventId}`,
      `/v1/vendadireta/anuncios/${wl}/${eventId}`,
      `/v1/venda-direta/anuncios/${wl}/${eventId}`,
      `/v1/publica/anuncios/${wl}/${eventId}`,
      `/v1/publica/lista/anuncios/${wl}/${eventId}`,
      `/v1/vendadireta/lista/${wl}/${eventId}`,
      `/v1/auditorio/anuncios/${eventId}`,
      `/v1/vendadireta/evento/${eventId}`,
      `/v1/publica/evento/${eventId}/anuncios`,
    ];
    const out = [];
    for (const p of paths) {
      try {
        const res = await this.api.get(p);
        const d = res.data;
        let len = null;
        if (Array.isArray(d)) len = d.length;
        else if (d && Array.isArray(d.results)) len = d.results.length;
        else if (d && Array.isArray(d.data)) len = d.data.length;
        out.push({ path: p.replace(String(wl), 'WL'), status: res.status, len, keys: (d && typeof d === 'object' && !Array.isArray(d)) ? Object.keys(d).slice(0, 6) : null });
      } catch (e) {
        out.push({ path: p.replace(String(wl), 'WL'), status: e.response ? e.response.status : 'ERR', err: e.message.slice(0, 60) });
      }
    }
    return out;
  }

  // TEMPORARIO (diagnostico): mostra a estrutura CRUA da resposta de anuncios
  // pra descobrir por que veio vazio (formato mudou? whitelabel? id?).
  async _debugRawVehicles(eventId) {
    await this.ensureAuth();
    const whitelabelId = process.env.DEALERS_WHITELABEL_ID;
    const url = `/v1/auditorio/anuncios/${whitelabelId}/${eventId}`;
    try {
      const res = await this.api.get(url);
      const d = res.data;
      const isObj = d && typeof d === 'object' && !Array.isArray(d);
      const results = isObj ? d.results : null;
      return {
        httpStatus: res.status,
        whitelabelPresent: !!whitelabelId,
        whitelabelLen: (whitelabelId || '').length,
        urlPath: url.replace(String(whitelabelId), 'WL'),
        topLevelType: Array.isArray(d) ? 'array' : typeof d,
        topLevelKeys: isObj ? Object.keys(d) : null,
        topArrayLen: Array.isArray(d) ? d.length : null,
        resultsIsArray: Array.isArray(results),
        resultsLen: Array.isArray(results) ? results.length : null,
        firstItemKeys: (Array.isArray(results) && results[0]) ? Object.keys(results[0]) : (Array.isArray(d) && d[0] ? Object.keys(d[0]) : null),
        rawSample: JSON.stringify(d).slice(0, 400),
      };
    } catch (e) {
      return { error: e.message, httpStatus: e.response ? e.response.status : null, body: e.response ? JSON.stringify(e.response.data).slice(0, 400) : null };
    }
  }

  async placeBid(advertisementId, value) {
    await this.ensureAuth();
    const body = {
      value: value,
      advertisement_id: advertisementId,
      shop_id: parseInt(process.env.DEALERS_SHOP_ID)
    };
    return this.requestWithRetry(async () => {
      const res = await this.api.post('/v1/auditorio/oferta', body);
      return res.data;
    });
  }

  async placeAutoBid(advertisementId, maxValue, tiebreaker = false) {
    await this.ensureAuth();
    const body = {
      value: maxValue,
      advertisement_id: advertisementId,
      shop_id: parseInt(process.env.DEALERS_SHOP_ID),
      tiebreaker: tiebreaker
    };
    return this.requestWithRetry(async () => {
      const res = await this.api.post('/v1/auditorio/oferta-automatica', body);
      return res.data;
    });
  }

  async buyNow(advertisementId, value) {
    await this.ensureAuth();
    const body = {
      value: value,
      advertisement_id: advertisementId,
      shop_id: parseInt(process.env.DEALERS_SHOP_ID)
    };
    return this.requestWithRetry(async () => {
      const res = await this.api.post('/v1/auditorio/compre-ja', body);
      return res.data;
    });
  }

  async toggleFavorite(advertisementId) {
    await this.ensureAuth();
    return this.requestWithRetry(async () => {
      const res = await this.api.get(`/v1/auditorio/anuncios/favoritar/${advertisementId}`);
      return res.data;
    });
  }

  async getMyPurchases() {
    await this.ensureAuth();
    const shopId = process.env.DEALERS_SHOP_ID;
    return this.requestWithRetry(async () => {
      const res = await this.api.get(`/v1/auditorio/anuncios/compras/${shopId}?page=1&per_page=50&situation=sold`);
      return res.data.results || res.data;
    });
  }

  async getMyPurchasesFromAccount(email, password, shopId, whitelabelId) {
    const tempApi = axios.create({
      baseURL: process.env.DEALERS_API_URL,
      headers: { 'Origin': 'https://vendadireta.dealersclub.com.br' }
    });
    const deviceToken = crypto.randomUUID();
    const loginRes = await tempApi.post('/v1/login', {
      email,
      password,
      whitelabel_origin_id: parseInt(whitelabelId)
    }, {
      headers: { 'X-Device-Token': deviceToken }
    });
    const token = loginRes.data.results.access_token;
    tempApi.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    const res = await tempApi.get(`/v1/auditorio/anuncios/compras/${shopId}?page=1&per_page=100&situation=sold`);
    return res.data.results || res.data;
  }

  async getMyOffers() {
    await this.ensureAuth();
    const shopId = process.env.DEALERS_SHOP_ID;
    return this.requestWithRetry(async () => {
      const res = await this.api.get(`/v1/auditorio/minhas-ofertas/${shopId}`);
      return res.data.results || res.data;
    });
  }
}

module.exports = new DealersService();
