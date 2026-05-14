const axios = require('axios');
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
        'Origin': process.env.DEALERS_ORIGIN,
        'Referer': process.env.DEALERS_ORIGIN + '/'
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

  async getEvents() {
    await this.ensureAuth();
    const res = await this.api.get('/v1/publica/lista/eventos');
    return res.data;
  }

  async getEventDetails(eventId) {
    await this.ensureAuth();
    const whitelabelId = process.env.DEALERS_WHITELABEL_ID;
    const res = await this.api.get(`/v1/auditorio/evento/${eventId}`);
    return res.data.results;
  }

  async getEventVehicles(eventId) {
    await this.ensureAuth();
    const whitelabelId = process.env.DEALERS_WHITELABEL_ID;
    const res = await this.api.get(`/v1/auditorio/anuncios/${whitelabelId}/${eventId}`);
    return res.data.results;
  }

  async getOffers(advertisementId) {
    await this.ensureAuth();
    const res = await this.api.get(`/v1/auditorio/oferta/${advertisementId}`);
    return res.data.results;
  }

  async placeBid(advertisementId, value) {
    await this.ensureAuth();
    const body = {
      value: value,
      advertisement_id: advertisementId,
      shop_id: parseInt(process.env.DEALERS_SHOP_ID)
    };
    const res = await this.api.post('/v1/auditorio/oferta', body);
    return res.data;
  }

  async placeAutoBid(advertisementId, maxValue, tiebreaker = false) {
    await this.ensureAuth();
    const body = {
      value: maxValue,
      advertisement_id: advertisementId,
      shop_id: parseInt(process.env.DEALERS_SHOP_ID),
      tiebreaker: tiebreaker
    };
    const res = await this.api.post('/v1/auditorio/oferta-automatica', body);
    return res.data;
  }

  async buyNow(advertisementId, value) {
    await this.ensureAuth();
    const body = {
      value: value,
      advertisement_id: advertisementId,
      shop_id: parseInt(process.env.DEALERS_SHOP_ID)
    };
    const res = await this.api.post('/v1/auditorio/compre-ja', body);
    return res.data;
  }

  async toggleFavorite(advertisementId) {
    await this.ensureAuth();
    const whitelabelId = process.env.DEALERS_WHITELABEL_ID;
    const res = await this.api.get(`/v1/auditorio/anuncios/favoritar/${advertisementId}`);
    return res.data;
  }

  async getMyPurchases() {
    await this.ensureAuth();
    const shopId = process.env.DEALERS_SHOP_ID;
    const res = await this.api.get(`/v1/auditorio/minhas-compras/${shopId}`);
    return res.data.results || res.data;
  }

  async getMyOffers() {
    await this.ensureAuth();
    const shopId = process.env.DEALERS_SHOP_ID;
    const res = await this.api.get(`/v1/auditorio/minhas-ofertas/${shopId}`);
    return res.data.results || res.data;
  }
}

module.exports = new DealersService();
