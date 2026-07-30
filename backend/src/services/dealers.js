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



  // TEMPORARIO (diag): tenta anuncios com Origins/whitelabels diferentes pra
  // achar o contexto certo (venda direta). Remover depois.
  async _probeOrigins(eventId) {
    await this.ensureAuth();
    const token = this.token;
    const wl = process.env.DEALERS_WHITELABEL_ID;
    const origins = [
      process.env.DEALERS_AUDITORIO_ORIGIN,
      'https://vendadireta-auditorio.dealersclub.com.br',
      'https://vendadireta.dealersclub.com.br',
      'https://auditorio.dealersclub.com.br',
    ];
    const out = [];
    for (const orig of origins) {
      for (const w of [wl, '1', '2']) {
        try {
          const tmp = axios.create({ baseURL: process.env.DEALERS_API_URL, headers: {
            'Accept': 'application/json', 'Authorization': 'Bearer ' + token,
            'Origin': orig, 'Referer': (orig || '') + '/'
          }});
          const res = await tmp.get(`/v1/auditorio/anuncios/${w}/${eventId}`);
          const d = res.data;
          const len = Array.isArray(d && d.results) ? d.results.length : (Array.isArray(d) ? d.length : null);
          out.push({ origin: orig, wl: w, status: res.status, len });
        } catch (e) {
          out.push({ origin: orig, wl: w, status: e.response ? e.response.status : 'ERR' });
        }
      }
    }
    return out;
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
