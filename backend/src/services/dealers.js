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




  // TEMP diag: testa os endpoints NOVOS (jornada-compra) da venda direta.
  async _debugJornada(eventId) {
    await this.ensureAuth();
    const out = { events: [], tests: [] };
    try {
      const evs = await this.getEvents();
      const arr = Array.isArray(evs) ? evs : (evs && evs.results) || (evs && evs.data) || [];
      out.events = arr.slice(0, 12).map(e => ({ id: e.id, name: e.name }));
      if (!eventId && arr.length) eventId = arr[0].id;
    } catch (e) { out.eventsErr = e.message; }
    const paths = [
      `/v1/jornada-compra/ofertas-lista/evento/${eventId}/anuncios`,
      `/v1/jornada-compra/anuncios/veiculos/lista-veiculos?event_ids[]=${eventId}`,
    ];
    for (const p of paths) {
      try {
        const res = await this.api.get(p);
        const d = res.data;
        let items = Array.isArray(d) ? d : (d && (d.results || d.data || d.anuncios)) || null;
        const len = Array.isArray(items) ? items.length : null;
        out.tests.push({ path: p.replace(String(eventId), 'EV'), status: res.status, len, topKeys: (d && typeof d === 'object' && !Array.isArray(d)) ? Object.keys(d).slice(0, 8) : null, firstItemKeys: (Array.isArray(items) && items[0]) ? Object.keys(items[0]).slice(0, 25) : null, sample: JSON.stringify(Array.isArray(items) && items[0] ? items[0] : d).slice(0, 800) });
      } catch (e) { out.tests.push({ path: p.replace(String(eventId), 'EV'), status: e.response ? e.response.status : e.message }); }
    }
    out.eventIdUsed = eventId;
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
