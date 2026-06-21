// build-figurinhas-catalog.js
// Transforma o catálogo extraído (catalog/catalogo.json) no asset que o app de
// figurinhas consome: frontend/figurinhas-catalogo.json.
//
//   - byId: mapa "código do álbum" -> { preco, estoque, img } (preço/foto reais
//           da MGA por figurinha; alimenta os cards do álbum e a aba Vendas)
//   - loja: lista de produtos pra aba "Loja" (foto, nome, preço, estoque)
//
// Uso: node build-figurinhas-catalog.js   (rode depois do scrape-catalog.js)

const fs = require('fs');
const path = require('path');
const { ID_SET } = require('./backend/src/services/figurinhasAlbum');

const SRC = path.join(__dirname, 'catalog', 'catalogo.json');
const OUT = path.join(__dirname, 'frontend', 'figurinhas-catalogo.json');

// Extrai o código do álbum (ex.: "FWC0", "BRA5", "CC14") a partir do nome do
// produto. Cobre "001 - FWC 00", "977-FWC 16" e os "CC1".."CC14" da Coca-Cola.
function toAlbumId(nome) {
  const n = String(nome || '').trim();
  let m = n.match(/^\d+\s*[-–]\s*([A-Za-z]{2,4})\s*0*(\d+)\s*$/);
  if (m) return m[1].toUpperCase() + parseInt(m[2], 10);
  m = n.match(/^([A-Za-z]{2,4})\s*0*(\d+)$/);
  if (m) return m[1].toUpperCase() + parseInt(m[2], 10);
  return null;
}

function main() {
  const cat = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const byId = {};
  const loja = [];

  for (const p of cat) {
    const preco = parseFloat(p.preco);
    const estoque = parseInt(p.estoque, 10);
    const codigo = String(p.codigo || '').trim();
    const img = p.url_imagem || '';

    // Produtos válidos pra Loja: têm código e preço (descarta as entradas-lixo
    // que são só nomes de categoria, e o placeholder "Pedido mínimo").
    const valido = codigo && preco > 0 && !/pedido m[ií]nimo/i.test(p.nome || '');
    if (!valido) continue;

    const albumId = toAlbumId(p.nome);
    if (albumId && ID_SET.has(albumId) && !byId[albumId]) {
      byId[albumId] = { preco, estoque: isNaN(estoque) ? 0 : estoque, img };
    }

    loja.push({
      codigo,
      nome: p.nome || '',
      categoria: p.categoria || 'Outros',
      preco,
      estoque: isNaN(estoque) ? 0 : estoque,
      img,
      albumId: albumId && ID_SET.has(albumId) ? albumId : null,
    });
  }

  // Ordena a loja por categoria e depois por nome (pt-BR).
  loja.sort((a, b) => (a.categoria + a.nome).localeCompare(b.categoria + b.nome, 'pt-BR'));

  const out = { generatedAt: new Date().toISOString(), byId, loja };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));

  console.log(`Figurinhas com preço/foto real (byId): ${Object.keys(byId).length}`);
  console.log(`Produtos na Loja: ${loja.length}`);
  console.log(`Arquivo: ${path.relative(__dirname, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
}

main();
