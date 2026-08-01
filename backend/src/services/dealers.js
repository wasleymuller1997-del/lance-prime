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

  // A Dealers migrou o catalogo pro /v1/jornada-compra e desligou o
  // /v1/auditorio/anuncios (voltava vazio). Alem disso a conta principal (env)
  // perdeu acesso ao catalogo novo. Entao usamos a conta secundaria da tabela
  // dealers_accounts (a que ainda enxerga o catalogo) so pra LISTAR os carros.
  async _catalogSession() {
    if (this._catApi && this._catExp && new Date() < this._catExp) return this._catApi;
    const { pool } = require('./db');
    const envShop = process.env.DEALERS_SHOP_ID || '';
    let email = process.env.DEALERS_EMAIL, password = process.env.DEALERS_PASSWORD, wl = process.env.DEALERS_WHITELABEL_ID || '8';
    try {
      // Prefere uma conta DIFERENTE da principal do env (a principal perdeu
      // acesso ao catalogo novo). Se so tiver a principal, usa ela mesmo.
      const r = await pool.query('SELECT email, password, whitelabel_id FROM dealers_accounts ORDER BY (shop_id <> $1) DESC, id LIMIT 1', [envShop]);
      if (r.rows.length) { email = r.rows[0].email; password = r.rows[0].password; wl = r.rows[0].whitelabel_id || '8'; }
    } catch (e) { /* fallback pro env */ }
    const api = axios.create({ baseURL: process.env.DEALERS_API_URL, headers: {
      'Accept': 'application/json', 'Content-Type': 'application/json',
      'Origin': process.env.DEALERS_AUDITORIO_ORIGIN, 'Referer': process.env.DEALERS_AUDITORIO_ORIGIN + '/'
    }});
    const lr = await api.post('/v1/login', { email, password, whitelabel_origin_id: parseInt(wl) }, { headers: { 'X-Device-Token': crypto.randomUUID() } });
    api.defaults.headers.common['Authorization'] = 'Bearer ' + lr.data.results.access_token;
    this._catApi = api;
    this._catExp = new Date(lr.data.results.expires_at || (Date.now() + 50 * 60 * 1000));
    return api;
  }

  // Normaliza um anuncio da API nova (jornada-compra) pro formato que o resto
  // do sistema ja espera (vehicle/negotiation/offer_actual...).
  _mapNewAnuncio(it) {
    const g = Array.isArray(it.images) ? it.images : (Array.isArray(it.gallery) ? it.gallery : null);
    const gallery = g && g.length
      ? g.map(x => (typeof x === 'string' ? { image: x, thumb: x } : { image: x.image || x.url || x.thumb, thumb: x.thumb || x.image || x.url }))
      : (it.image ? [{ image: it.image, thumb: it.image }] : []);
    return {
      id: it.uid || it.id,
      uid: it.uid,
      offers: it.offers_count || it.offers || 0,
      vehicle: {
        brand_name: it.brand_name || '',
        model_name: it.model_name || '',
        version_name: it.version_name || '',
        manufacture_year: it.manufacture_year || it.year_manufacture || null,
        model_year: it.model_year || it.year_model || null,
        km: it.km || 0,
        color_name: it.color_name || it.color || '',
        fuel_name: it.fuel_name || it.fuel || '',
        drive_shift_name: it.drive_shift_name || it.transmission || '',
        category_name: it.category_name || '',
        description: it.description || '',
        image_gallery: gallery,
      },
      negotiation: {
        value_actual: it.value_actual || 0,
        value_initial: it.value_initial || it.value_actual || 0,
        increment: it.increment || 0,
        immediate_sale_price: it.immediate_sale_price || null,
        finish_date_offer: it.finish_date_offer || null,
        start_date_offer: it.start_date_offer || null,
      },
      offer_actual: it.offer_actual || null,
      shop: { name: it.shop_name || 'Loja parceira', city: it.city || '', state: it.uf || it.state || '' },
      precautionary_report: it.precautionary_report || null,
    };
  }

  async getEventVehicles(eventId) {
    const api = await this._catalogSession();
    const res = await api.get(`/v1/jornada-compra/ofertas-lista/evento/${eventId}/anuncios`);
    const raw = res.data && res.data.results;
    let items = [];
    if (Array.isArray(raw)) {
      for (const grp of raw) {
        if (Array.isArray(grp)) items = items.concat(grp);
        else if (grp) items.push(grp);
      }
    }
    return items.map(it => this._mapNewAnuncio(it));
  }

  async getOffers(advertisementId) {
    await this.ensureAuth();
    return this.requestWithRetry(async () => {
      const res = await this.api.get(`/v1/auditorio/oferta/${advertisementId}`);
      return res.data.results;
    });
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
