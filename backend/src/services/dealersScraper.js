/**
 * Cliente da API Dealers Club pra buscar dados completos de um anúncio.
 *
 * Antes usava Puppeteer pra raspar a página HTML (lento, pesado, não rodava
 * no Render free por falta de memória pro Chromium).
 *
 * Agora usa endpoint REST direto:
 *   GET /api/v1/jornada-compra/ofertas-lista/{uuid}
 *
 * Retorna o mesmo formato que a versão Puppeteer pra não quebrar o endpoint
 * /api/import-from-url.
 */

const axios = require('axios');
const crypto = require('crypto');

const DEALERS_API = 'https://prod-backend.dealersclub.com.br/api';
const ORIGIN = 'https://vendadireta.dealersclub.com.br';

function extractUuidFromUrl(input) {
  if (!input) return null;
  const match = String(input).match(/([a-f0-9]{32})/i);
  return match ? match[1] : null;
}

async function loginDealers(email, password, whitelabelId = 8) {
  const deviceToken = crypto.randomUUID();
  const res = await axios.post(DEALERS_API + '/v1/login', {
    email,
    password,
    whitelabel_origin_id: parseInt(whitelabelId)
  }, {
    timeout: 15000,
    headers: {
      'X-Device-Token': deviceToken,
      'Origin': ORIGIN,
      'Referer': ORIGIN + '/'
    }
  });
  return res.data.results.access_token;
}

async function fetchAnuncioRaw(token, uuid) {
  const res = await axios.get(`${DEALERS_API}/v1/jornada-compra/ofertas-lista/${uuid}`, {
    timeout: 20000,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Origin': ORIGIN,
      'Referer': ORIGIN + '/'
    }
  });
  if (!res.data || !res.data.results || !res.data.results.advertisement) {
    throw new Error('Resposta da API sem dados do anúncio');
  }
  return res.data.results.advertisement;
}

// Mapeia o JSON cru da API pro formato que o endpoint /api/import-from-url espera
function mapToImportFormat(adv) {
  const v = adv.vehicle || {};
  const shop_stock = adv.shop_stock || {};
  const shop = adv.shop || {};

  // Galeria de fotos: prefere image_gallery, fallback pra images
  let fotos = [];
  const gallerySource = (Array.isArray(v.image_gallery) && v.image_gallery.length > 0)
    ? v.image_gallery
    : (Array.isArray(v.images) ? v.images : []);
  for (const item of gallerySource) {
    if (typeof item === 'string') fotos.push(item);
    else if (item && typeof item === 'object') {
      const url = item.image || item.url || item.path || item.file;
      if (url) fotos.push(url);
    }
  }

  // Laudo: a Dealers usa o campo `file_url` (não `file` nem `url`). Já vi os 3
  // formatos diferentes em respostas, então aceitamos todos pra segurança.
  let laudo = null;
  if (v.precautionary_report) {
    laudo = v.precautionary_report.file_url
         || v.precautionary_report.file
         || v.precautionary_report.url
         || v.precautionary_report;
    if (typeof laudo !== 'string') laudo = null;
  }

  // Localização: prefere shop_stock (HUB do veículo), fallback pra shop (vendedor)
  let localizacao = null;
  if (shop_stock.name || shop_stock.city) {
    const parts = [];
    if (shop_stock.name) parts.push(shop_stock.name);
    if (shop_stock.street) parts.push(shop_stock.street + (shop_stock.number ? ', ' + shop_stock.number : ''));
    if (shop_stock.district) parts.push(shop_stock.district);
    if (shop_stock.city && shop_stock.state) parts.push(shop_stock.city + '/' + shop_stock.state);
    if (shop_stock.postal_code) parts.push('CEP: ' + shop_stock.postal_code);
    localizacao = parts.join('\n');
  }

  // Vendedor
  let vendedor = null;
  if (shop.name) {
    const parts = [shop.name];
    if (shop.street) parts.push(shop.street + (shop.number ? ', ' + shop.number : ''));
    if (shop.city && shop.state) parts.push(shop.city + '/' + shop.state);
    if (shop.postal_code) parts.push('CEP: ' + shop.postal_code);
    if (shop.comercial_number) parts.push('Tel: ' + shop.comercial_number);
    vendedor = parts.join('\n');
  }

  // Ano formato "2024/2024"
  let ano = null;
  if (v.manufacture_year && v.model_year) ano = v.manufacture_year + '/' + v.model_year;
  else if (v.model_year) ano = String(v.model_year);
  else if (v.manufacture_year) ano = String(v.manufacture_year);

  // KM: usa vehicle.km direto. Se vier vazio, tenta extrair da descrição
  // (padrões típicos: "KM: 12345", "Quilometragem: 12.345 km", "12345 km")
  let km = v.km || null;
  if (!km && v.description) {
    const patterns = [
      /KM\s*[:=]\s*(\d{1,3}(?:\.\d{3})*|\d+)/i,
      /Quilometragem\s*[:=]\s*(\d{1,3}(?:\.\d{3})*|\d+)/i,
      /(\d{1,3}(?:\.\d{3})*)\s*km/i
    ];
    for (const re of patterns) {
      const m = v.description.match(re);
      if (m) { km = parseInt(m[1].replace(/\./g, '')); if (km > 0) break; }
    }
  }

  // Preço: pega da oferta atual (sem spread, valor real)
  let valor = null;
  if (adv.offer_actual && adv.offer_actual.price) valor = adv.offer_actual.price;
  else if (adv.negotiation && adv.negotiation.value_actual) valor = adv.negotiation.value_actual;

  return {
    dealers_uuid: adv.id_elastic || null,
    codigo: adv.id ? String(adv.id) : null,
    marca: v.brand_name || null,
    modelo: v.model_name || null,
    versao: v.version_name || null,
    ano,
    km,
    cambio: v.drive_shift_name || null,
    combustivel: v.fuel_name || null,
    cor: v.color_name || null,
    carroceria: v.bodywork_name || null,
    placa: v.plate || null,
    chassi: v.chassi || null,
    valor,
    descricao: v.description || null,
    localizacao,
    vendedor,
    fotos,
    laudo,
    fipe_price: adv.fipe_price || v.fipe_price || null
  };
}

/**
 * Função pública: busca dados completos de um anúncio.
 * @param {string} urlOrUuid - URL completa ou UUID do anúncio
 * @param {{email: string, password: string, whitelabel_id?: number}} credentials
 * @returns {Promise<object>} dados normalizados do anúncio
 */
async function scrapeAnuncio(urlOrUuid, credentials) {
  const uuid = extractUuidFromUrl(urlOrUuid);
  if (!uuid) throw new Error('UUID não encontrado. Cole o link completo do anúncio.');
  if (!credentials || !credentials.email || !credentials.password) {
    throw new Error('Credenciais Dealers obrigatórias.');
  }
  const token = await loginDealers(credentials.email, credentials.password, credentials.whitelabel_id || 8);
  const adv = await fetchAnuncioRaw(token, uuid);
  return mapToImportFormat(adv);
}

module.exports = { scrapeAnuncio, extractUuidFromUrl };
