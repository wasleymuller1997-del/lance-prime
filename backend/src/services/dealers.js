const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

class DealersService {
  constructor() {
    this.token = null;
    this.tokenExpiresAt = null;
    this.pausedUntil = 0; // ms epoch: enquanto > agora, a integracao nao loga (libera a conta pro dono)
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

  isPaused() { return this.pausedUntil && Date.now() < this.pausedUntil; }

  // Pausa a integracao por N minutos e SOLTA a sessao atual (logout best-effort),
  // pra a Dealers nao acusar "login multiplo" quando o dono entrar no navegador.
  async pause(minutes) {
    const min = Math.min(Math.max(parseInt(minutes) || 30, 1), 180);
    this.pausedUntil = Date.now() + min * 60 * 1000;
    const oldToken = this.token;
    this.token = null; this.tokenExpiresAt = null;
    this._catApi = null; this._catExp = null;
    delete this.api.defaults.headers.common['Authorization'];
    if (oldToken) {
      try { await this.api.post('/v1/logout', {}, { headers: { 'Authorization': 'Bearer ' + oldToken } }); } catch (e) { /* best-effort */ }
    }
    return this.pausedUntil;
  }
  resume() { this.pausedUntil = 0; }

  async login() {
    if (this.isPaused()) throw new Error('Integração Dealers pausada pelo admin');
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
    if (this.isPaused()) throw new Error('Integração Dealers pausada pelo admin');
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

  // Extrai o array de anuncios de qualquer formato que a API nova devolva.
  _extractAnuncios(body) {
    if (!body) return [];
    let r = body.results !== undefined ? body.results : (body.data !== undefined ? body.data : body);
    if (Array.isArray(r)) {
      if (r.length && Array.isArray(r[0])) { let out = []; for (const g of r) out = out.concat(g); return out; } // [[...]]
      return r;
    }
    if (r && Array.isArray(r.data)) return r.data;
    if (r && Array.isArray(r.anuncios)) return r.anuncios;
    return [];
  }

  async _fetchAllAnuncios() {
    // Cache COMPARTILHADO: o lista-veiculos traz TODOS os carros (todos os
    // eventos) numa resposta so (~3.8MB). Sem cache, cada evento aberto + cada
    // poll de 3s re-baixava tudo — era isso que deixava lento. Cache de 4s
    // deduplica: 1 busca na Dealers a cada ~4s, nao importa quantos eventos.
    const now = Date.now();
    if (this._anunciosCache && (now - (this._anunciosCacheAt || 0)) < 4000) return this._anunciosCache;
    if (this._anunciosInflight) return this._anunciosInflight; // evita busca duplicada concorrente
    this._anunciosInflight = this._doFetchAllAnuncios().then(items => {
      this._anunciosCache = items; this._anunciosCacheAt = Date.now(); this._anunciosInflight = null;
      return items;
    }).catch(err => { this._anunciosInflight = null; throw err; });
    return this._anunciosInflight;
  }

  async _doFetchAllAnuncios() {
    const api = await this._catalogSession();
    const wl = process.env.DEALERS_WHITELABEL_ID || '8';
    let items = [];
    let cursor = null;
    for (let guard = 0; guard < 40; guard++) {
      const params = ['sorts=mais_recentes', 'whitelabel_id=' + wl, 'per_page=200'];
      if (cursor) params.push('cursor=' + encodeURIComponent(cursor));
      const res = await api.get('/v1/jornada-compra/anuncios/veiculos/lista-veiculos?' + params.join('&'));
      const body = res.data || {};
      const page = this._extractAnuncios(body);
      items = items.concat(page);
      cursor = body.cursor || body.next_cursor || (body.results && (body.results.next_cursor || body.results.cursor)) || (body.meta && (body.meta.next_cursor || body.meta.cursor)) || null;
      if (!cursor || !page.length) break;
    }
    return items;
  }

  async getEventVehicles(eventId) {
    // A API nova (lista-veiculos) devolve a MESMA estrutura da antiga
    // (vehicle/negotiation/offer_actual/shop/event/id numerico), entao o resto
    // do sistema funciona sem adaptar. So filtramos pelo evento (o param
    // event_ids e ignorado pela API — cada anuncio traz .event.id).
    const items = await this._fetchAllAnuncios();
    if (!eventId) return items;
    const ev = String(eventId);
    return items.filter(it => it && it.event && String(it.event.id) === ev);
  }

  // Normaliza uma oferta da API nova (negociacao) pro formato antigo que o
  // resto do sistema espera. A API nova usa `price`; o codigo de reconciliacao
  // le `o.value`. Entao garantimos os dois campos.
  _normalizeOffer(o) {
    if (!o || typeof o !== 'object') return o;
    const val = o.value != null ? o.value : (o.price != null ? o.price : (o.amount != null ? o.amount : (o.value_offer != null ? o.value_offer : null)));
    return {
      ...o,
      value: val != null ? parseFloat(val) : null,
      price: o.price != null ? o.price : val,
      user_id: o.user_id != null ? o.user_id : (o.user_offer_id != null ? o.user_offer_id : (o.user && o.user.id) || null),
      shop_id: o.shop_id != null ? o.shop_id : (o.user_shop_id != null ? o.user_shop_id : (o.shop && o.shop.id) || null),
    };
  }

  // TEMP DEBUG: sonda varios endpoints de oferta (buyer/seller) com as duas
  // contas (catalogo=DG e env=wasley), so pra ver status/shape. Read-only.
  async _probe(api, method, path) {
    try {
      const res = await api.request({ method, url: path });
      const body = res.data;
      const arr = this._extractAnuncios(body);
      return { status: res.status, keys: body && typeof body === 'object' ? Object.keys(body) : typeof body, count: Array.isArray(arr) ? arr.length : null, sample: Array.isArray(arr) && arr.length ? arr[0] : (Array.isArray(arr) ? null : body) };
    } catch (err) {
      return { status: err.response && err.response.status, error: err.message, body: err.response && err.response.data };
    }
  }

  async _rawBody(api, method, path) {
    try { const res = await api.request({ method, url: path }); return { status: res.status, body: res.data }; }
    catch (err) { return { status: err.response && err.response.status, error: err.message, body: err.response && err.response.data }; }
  }

  async _debugOffersRaw(advertisementId) {
    const cat = await this._catalogSession();
    const out = {};
    out['ofertas-lista RAW'] = await this._rawBody(cat, 'get', `/v1/jornada-compra/ofertas-lista/${advertisementId}`);
    out['minhas-ofertas RAW'] = await this._rawBody(cat, 'get', '/v1/jornada-compra/minhas-ofertas?page=1&per_page=20');
    return out;
  }

  // MIGRADO pra API nova (negociacao). O /v1/auditorio/oferta/{id} morreu junto
  // com o auditorio. Agora lemos as ofertas do lote pelo endpoint novo, usando a
  // sessao do catalogo (conta que enxerga os anuncios). Read-only, seguro.
  async getOffers(advertisementId) {
    const api = await this._catalogSession();
    try {
      const res = await api.get(`/v1/negociacao/anuncios/${advertisementId}/ofertas`);
      const arr = this._extractAnuncios(res.data);
      if (Array.isArray(arr)) return arr.map(o => this._normalizeOffer(o));
      return arr;
    } catch (err) {
      // Fallback pro endpoint antigo (caso ainda responda em algum lote legado).
      if (err.response && (err.response.status === 404 || err.response.status === 405)) {
        try {
          await this.ensureAuth();
          const res = await this.api.get(`/v1/auditorio/oferta/${advertisementId}`);
          const r = res.data && res.data.results;
          if (Array.isArray(r)) return r.map(o => this._normalizeOffer(o));
          return r;
        } catch (e2) { /* cai no throw abaixo */ }
      }
      throw err;
    }
  }





  // MIGRADO pra API nova (negociacao). O auditorio/oferta morreu.
  // Novo endpoint: POST /v1/negociacao/anuncios/{adId}/ofertas
  // O anuncio vai no PATH, entao o corpo NAO leva advertisement_id.
  // Campos confirmados no form da Dealers: price + negotiation_type (3 = lance/oferta).
  // A oferta e feita pela conta autenticada (a mesma que enxerga o catalogo),
  // entao NAO enviamos user_offer_id/user_shop_id (isso e so pro form do admin
  // que oferta em nome de terceiros).
  async placeBid(advertisementId, value) {
    const api = await this._catalogSession();
    const body = { price: Number(value), negotiation_type: 3 };
    const res = await api.post(`/v1/negociacao/anuncios/${advertisementId}/ofertas`, body);
    return res.data;
  }

  // MIGRADO pra API nova. POST /v1/negociacao/anuncios/{adId}/oferta-automatica
  async placeAutoBid(advertisementId, maxValue, tiebreaker = false) {
    const api = await this._catalogSession();
    const body = { price: Number(maxValue), negotiation_type: 3 };
    if (tiebreaker) body.tiebreaker = true;
    const res = await api.post(`/v1/negociacao/anuncios/${advertisementId}/oferta-automatica`, body);
    return res.data;
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
