const puppeteer = require('puppeteer-core');

async function main() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  console.log('Iniciando Chrome...');

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false, // Mostrar navegador para debug
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--start-maximized']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  console.log('Acessando Dealers Club...');
  await page.goto('https://vendadireta.dealersclub.com.br/', { waitUntil: 'networkidle2', timeout: 60000 });

  // Esperar a SPA carregar
  console.log('Aguardando SPA carregar...');
  await new Promise(r => setTimeout(r, 10000));

  await page.screenshot({ path: 'dealers_1.png' });
  console.log('Screenshot 1 salvo');

  // Verificar se tem inputs
  const inputCount = await page.evaluate(() => document.querySelectorAll('input').length);
  console.log('Inputs na pagina:', inputCount);

  if (inputCount === 0) {
    // Tentar esperar mais
    console.log('Aguardando mais...');
    await new Promise(r => setTimeout(r, 10000));
    const inputCount2 = await page.evaluate(() => document.querySelectorAll('input').length);
    console.log('Inputs apos espera:', inputCount2);
  }

  // Pegar todo HTML
  const bodyHtml = await page.evaluate(() => document.body.innerHTML);
  console.log('Body HTML (1000 chars):', bodyHtml.substring(0, 1000));

  console.log('Fazendo login...');

  try {
    // Tentar preencher campos
    await page.waitForSelector('input', { timeout: 5000 });
    const inputEls = await page.$$('input');
    console.log('Inputs encontrados:', inputEls.length);

    if (inputEls.length >= 2) {
      await inputEls[0].type('dagarg78@gmail.com', { delay: 30 });
      await inputEls[1].type('Senha@357', { delay: 30 });

      await page.screenshot({ path: 'dealers_2.png' });
      console.log('Screenshot 2 salvo');

      // Clicar no botão de login
      await page.click('button');
      await new Promise(r => setTimeout(r, 8000));

      await page.screenshot({ path: 'dealers_3.png' });
      console.log('Screenshot 3 salvo - URL:', page.url());

      // Procurar e clicar em "Compras"
      console.log('Procurando menu de compras...');

      const clicked = await page.evaluate(() => {
        const elements = document.querySelectorAll('a, button, div, span, li');
        for (const el of elements) {
          const text = (el.innerText || '').toLowerCase();
          if (text.includes('compra') && !text.includes('comprar')) {
            el.click();
            return el.innerText;
          }
        }
        return null;
      });

      if (clicked) {
        console.log('Clicou em:', clicked);
        await new Promise(r => setTimeout(r, 5000));
      }

      await page.screenshot({ path: 'dealers_4.png' });
      console.log('Screenshot 4 salvo');

      // Pegar conteúdo
      const pageText = await page.evaluate(() => document.body.innerText);
      console.log('\n=== CONTEUDO ===\n');
      console.log(pageText);
    }
  } catch (e) {
    console.log('Erro nos inputs:', e.message);

    // Mostrar o que tem na página
    const allText = await page.evaluate(() => document.body.innerText);
    console.log('Texto da pagina:', allText.substring(0, 2000));
  }

  // Manter navegador aberto por 30 segundos para debug
  console.log('\nMantenha o navegador aberto por 30s para debug...');
  await new Promise(r => setTimeout(r, 30000));

  await browser.close();
  console.log('Navegador fechado.');
}

main().catch(e => console.error('Erro:', e.message));
