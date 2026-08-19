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

  // Sessao usada pra ENVIAR lance e LER ofertas do auditorio.
  //
  // Descoberta (engenharia reversa do app do auditorio,
  // vendadireta-auditorio.dealersclub.com.br): o auditorio NUNCA morreu — o app
  // atual ainda usa /v1/auditorio/oferta. O que quebrou o lance foi a CONTA
  // (wasley com "login multiplo"/401), nao o endpoint.
  //
  // Qual conta usar:
  //  - padrao: conta do env (wasley) — o lance/compra tem que sair NELA.
  //  - DEALERS_BID_ACCOUNT=catalog: usa a conta do catalogo (DG) — util como
  //    contingencia, ja que a DG comprova que consegue dar lance no auditorio.
  async _bidSession() {
    if ((process.env.DEALERS_BID_ACCOUNT || 'env') === 'catalog') {
      return this._catalogSession();
    }
    await this.ensureAuth();
    return this.api;
  }

  // Le as ofertas de um lote: GET /v1/auditorio/oferta/{adId} (endpoint vivo).
  // Reconciliacao usa isso pra achar o maior lance (vencedor). Nunca lanca —
  // se falhar (conta caida, lote fechado), devolve [] e o reconciliador cai no
  // vigia de fechamento (last_leading_value).
  async getOffers(advertisementId) {
    try {
      const api = await this._bidSession();
      const res = await api.get(`/v1/auditorio/oferta/${advertisementId}`);
      const r = res.data && res.data.results;
      return Array.isArray(r) ? r : (r ? [r] : []);
    } catch (err) {
      return [];
    }
  }

  // TEMP DEBUG: confirma leitura do auditorio/oferta com as duas contas. Remover.
  async _debugAuditorioRead(advertisementId) {
    const out = {};
    const test = async (label, getApi) => {
      try { const api = await getApi(); const r = await api.get(`/v1/auditorio/oferta/${advertisementId}`); const res = r.data && r.data.results;
        out[label] = { status: r.status, resultsType: Array.isArray(res) ? `array(${res.length})` : typeof res, sample: Array.isArray(res) && res.length ? res[0] : res }; }
      catch (e) { out[label] = { status: e.response && e.response.status, code: e.response && e.response.data && e.response.data.code, msg: e.response && e.response.data && e.response.data.message || e.message }; }
    };
    await test('env (wasley)', async () => { await this.ensureAuth(); return this.api; });
    await test('catalog (DG)', () => this._catalogSession());
    return out;
  }

  // LANCE (envio) — auditorio, endpoint VIVO.
  //
  // Corpo EXATO capturado do app do auditorio (funcao cs):
  //   POST /v1/auditorio/oferta   body: { value, advertisement_id }
  // Sem shop_id (o app real nao envia). A conta que assina o lance e a de
  // _bidSession() (padrao: wasley/env), entao a compra sai na conta certa.
  async placeBid(advertisementId, value) {
    const api = await this._bidSession();
    const body = { value: Number(value), advertisement_id: Number(advertisementId) };
    return this.requestWithRetry(async () => {
      const res = await api.post('/v1/auditorio/oferta', body);
      return res.data;
    });
  }

  // Lance automatico: POST /v1/auditorio/oferta-automatica { value, advertisement_id }
  async placeAutoBid(advertisementId, maxValue, tiebreaker = false) {
    const api = await this._bidSession();
    const body = { value: Number(maxValue), advertisement_id: Number(advertisementId) };
    if (tiebreaker) body.tiebreaker = true;
    return this.requestWithRetry(async () => {
      const res = await api.post('/v1/auditorio/oferta-automatica', body);
      return res.data;
    });
  }

  // Compre Ja: POST /v1/auditorio/compre-ja { value, advertisement_id } (app real).
  async buyNow(advertisementId, value) {
    const api = await this._bidSession();
    const body = { value: Number(value), advertisement_id: Number(advertisementId) };
    return this.requestWithRetry(async () => {
      const res = await api.post('/v1/auditorio/compre-ja', body);
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
