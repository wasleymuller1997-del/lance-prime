/**
 * Scraper do Dealers Club via Puppeteer.
 *
 * Funciona em duas configurações:
 * - Local (Windows): usa Chrome instalado em C:\Program Files\Google\Chrome\
 * - Render/serverless: usa @sparticuz/chromium (Chromium otimizado)
 *
 * Faz login em vendadireta.dealersclub.com.br e extrai dados completos do anúncio
 * (28+ fotos da galeria, descrição completa, laudo PDF, dados estruturados).
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');

const IS_SERVERLESS = !!(process.env.RENDER || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL);

function findLocalChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

async function launchBrowser() {
  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  };

  if (IS_SERVERLESS) {
    const chromium = require('@sparticuz/chromium');
    launchOptions.args = [...chromium.args, ...launchOptions.args];
    launchOptions.executablePath = await chromium.executablePath();
    launchOptions.defaultViewport = chromium.defaultViewport;
  } else {
    const chromePath = findLocalChrome();
    if (!chromePath) throw new Error('Chrome não encontrado. Defina CHROME_PATH ou instale o Chrome.');
    launchOptions.executablePath = chromePath;
  }

  return puppeteer.launch(launchOptions);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractUuidFromUrl(input) {
  if (!input) return null;
  // Aceita: UUID direto, URL completa, URL com query, URL com fragment
  const uuidRegex = /([a-f0-9]{32})/i;
  const match = String(input).match(uuidRegex);
  return match ? match[1] : null;
}

async function loginDealers(page, email, password) {
  await page.goto('https://vendadireta.dealersclub.com.br/login', { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(2000);

  await page.waitForSelector('input[type="password"]', { timeout: 30000 });
  const inputs = await page.$$('input');
  if (inputs.length < 2) throw new Error('Página de login: inputs não encontrados');

  await inputs[0].click();
  await inputs[0].type(email, { delay: 30 });
  await inputs[1].click();
  await inputs[1].type(password, { delay: 30 });

  await page.evaluate(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if ((btn.innerText || '').toLowerCase().trim() === 'entrar') {
        btn.click();
        return;
      }
    }
  });

  // Espera o redirect pós-login
  await delay(6000);

  const url = page.url();
  if (url.includes('/login')) {
    throw new Error('Login falhou - ainda na tela de login (credenciais inválidas?)');
  }
  return true;
}

async function scrapeAnuncioByUuid(page, uuid) {
  await page.goto(`https://vendadireta.dealersclub.com.br/anuncio/veiculo/${uuid}`,
    { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(4000);

  const data = await page.evaluate((uuidArg) => {
    const result = {
      dealers_uuid: uuidArg,
      codigo: null, marca: null, modelo: null, versao: null,
      ano: null, km: null, cambio: null, combustivel: null,
      cor: null, carroceria: null,
      valor: null, descricao: null,
      localizacao: null, vendedor: null,
      fotos: [], laudo: null
    };

    const text = document.body.innerText;

    const codMatch = text.match(/Código do anúncio:\s*(\d+)/i);
    if (codMatch) result.codigo = codMatch[1];

    const h1 = document.querySelector('h1');
    if (h1) {
      const parts = h1.innerText.trim().split(' ');
      if (parts.length >= 2) {
        result.marca = parts[0];
        result.modelo = parts.slice(1).join(' ');
      }
    }

    // Versão: tenta encontrar perto do título
    const versaoMatch = text.match(/Versão\s*([^\n]+)/i);
    if (versaoMatch) result.versao = versaoMatch[1].trim();

    const anoMatch = text.match(/Ano\s*(\d{4}\/\d{4})/i) || text.match(/Ano\s*(\d{4})/i);
    if (anoMatch) result.ano = anoMatch[1];

    const kmMatch = text.match(/Km\s*([\d.]+)\s*km/i) || text.match(/Quilometragem\s*([\d.]+)/i);
    if (kmMatch) result.km = kmMatch[1].replace(/\./g, '');

    const cambioMatch = text.match(/Câmbio\s*(\w+)/i);
    if (cambioMatch) result.cambio = cambioMatch[1];

    const combMatch = text.match(/Combustível\s*([^\n]+)/i);
    if (combMatch) result.combustivel = combMatch[1].trim();

    const corMatch = text.match(/Cor\s*(\w+)/i);
    if (corMatch) result.cor = corMatch[1];

    const carroMatch = text.match(/Carroceria\s*([^\n]+)/i);
    if (carroMatch) result.carroceria = carroMatch[1].trim();

    const valorMatch = text.match(/R\$\s*([\d.]+(?:,\d{2})?)/);
    if (valorMatch) result.valor = valorMatch[1].replace(/\./g, '').replace(',', '.');

    const descMatch = text.match(/Sobre este veículo\s*([\s\S]*?)(?=Quer agendar|Localização|Dados do vendedor|$)/i);
    if (descMatch) result.descricao = descMatch[1].trim();

    const locMatch = text.match(/Localização do veículo\s*([\s\S]*?)(?=Abrir no Google|Dados do vendedor|$)/i);
    if (locMatch) result.localizacao = locMatch[1].trim();

    const vendMatch = text.match(/Dados do vendedor\s*([\s\S]*?)(?=Parabéns|Mais dessa|$)/i);
    if (vendMatch) result.vendedor = vendMatch[1].trim();

    // Fotos: só cloudfront/s3 (ignora logos, ícones, tacas de vencedor)
    const images = document.querySelectorAll('img');
    for (const img of images) {
      const src = img.src || img.getAttribute('data-src') || '';
      if (!src) continue;
      const isPhoto = (src.includes('cloudfront.net/vehicles/') || src.includes('s3.amazonaws.com/vehicles/'));
      if (isPhoto && !result.fotos.includes(src)) {
        result.fotos.push(src);
      }
    }

    // Laudo PDF
    const links = document.querySelectorAll('a');
    for (const link of links) {
      const href = link.href || '';
      if (href.includes('.pdf') && (href.includes('precautionary') || href.includes('laudo'))) {
        result.laudo = href;
        break;
      }
    }
    if (!result.laudo) {
      // Procurar por botão que abre laudo
      const allEls = document.querySelectorAll('a, button');
      for (const el of allEls) {
        if (el.innerText && el.innerText.toLowerCase().includes('laudo veicular')) {
          const parent = el.closest('a');
          if (parent && parent.href && parent.href.includes('.pdf')) {
            result.laudo = parent.href;
            break;
          }
        }
      }
    }

    return result;
  }, uuid);

  return data;
}

/**
 * Função principal: scrapeia um anúncio via URL/UUID.
 * @param {string} urlOrUuid - URL completa do anúncio ou UUID puro
 * @param {{email: string, password: string}} credentials
 * @returns {Promise<object>} dados do anúncio
 */
async function scrapeAnuncio(urlOrUuid, credentials) {
  const uuid = extractUuidFromUrl(urlOrUuid);
  if (!uuid) throw new Error('UUID não encontrado na URL fornecida. Cole o link completo do anúncio.');
  if (!credentials || !credentials.email || !credentials.password) {
    throw new Error('Credenciais Dealers obrigatórias. Cadastre uma conta em Configurações.');
  }

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

    await loginDealers(page, credentials.email, credentials.password);
    const data = await scrapeAnuncioByUuid(page, uuid);
    return data;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { scrapeAnuncio, extractUuidFromUrl };
