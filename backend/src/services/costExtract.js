// Lê o texto de um comprovante (PDF ou imagem) e tenta deduzir:
//   - amount (R$): pega o MAIOR valor associado a uma linha "TOTAL"; se não
//     achar TOTAL, pega o maior número monetário do documento.
//   - category: mapeia palavras-chave do conteúdo nas categorias do dropdown.
//   - description: usa a primeira linha "forte" (nome do prestador) + nº de
//     orçamento se achar.
//
// O serviço SÓ extrai — não salva nada no banco. A rota que chama decide o que
// fazer com o resultado (pré-preenche o form e o usuário confirma).

const { getMupdf, getTesseract } = require('./dealerSanitize');

// --- Categorização (mesmas opções do dropdown de custos no admin.html) ---
const CATEGORY_RULES = [
  // Frete/transporte do carro
  { cat: 'Frete', re: /\b(frete|cegonha|guincho|transporte do (veiculo|carro)|reboque)\b/i },
  // Reparo (oficina, funilaria, mecânica)
  { cat: 'Reparo', re: /\b(reparo|mecanic|funilaria|pintura|martelinho|retoque|para[\s-]?choque|emblema|oficina|chapeac)\b/i },
  // Revisão (óleo, peças, manutenção preventiva)
  { cat: 'Revisão', re: /\b(revisao|troca de oleo|filtro|aliment|correia|velas?|pastilha|disco de freio|alinhament|balance)\b/i },
  // Documentação
  { cat: 'Documentação', re: /\b(detran|crlv|crv|licenciament|transfer|despachante|documentacao)\b/i },
  // Limpeza/Estética
  { cat: 'Limpeza/Estética', re: /\b(higieniz|cristaliz|polim|estetic|lavagem|detal|enceram)\b/i },
  { cat: 'IPVA', re: /\bipva\b/i },
  { cat: 'Gasolina', re: /\b(gasolina|posto|combustiv|etanol|alcool|diesel)\b/i },
  { cat: 'Pedágio', re: /\b(pedagio|pedagios)\b/i },
  { cat: 'Comissão', re: /\b(comiss|corretagem)\b/i },
  { cat: 'Uber', re: /\b(uber|taxi|99 ?(motorista|app)?)\b/i },
];

function detectCategory(text) {
  const norm = (text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const { cat, re } of CATEGORY_RULES) {
    if (re.test(norm)) return cat;
  }
  return 'Outros';
}

// Extrai todos os valores monetários do texto (com ou sem R$). Trata as
// notações BR ("1.896,00" / "1896,00" / "1.896") e devolve em centavos pra
// ordenação justa. O parseToReais converte de volta.
function extractMoneyValues(text) {
  const out = [];
  // Captura: opcional R$, número com possíveis pontos como separador de milhar
  // e vírgula como decimal (2 dígitos). Aceita também sem decimais.
  const re = /(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    // Heurística: pra evitar capturar coisas como "320I" (modelo) ou anos
    // soltos, exige que o número apareça depois de "R$" OU tenha vírgula
    // decimal OU separador de milhar. Pra evitar capturar CNPJ/CEP/data.
    const ctx = text.slice(Math.max(0, m.index - 3), m.index);
    const hasCurrency = /R\$\s*$/.test(ctx);
    const hasDecimal = raw.includes(',');
    const hasThousand = raw.includes('.');
    if (!hasCurrency && !hasDecimal && !hasThousand) continue;
    // Descarta números curtos sem $/decimal (ano, modelo)
    const reais = parseFloat(raw.replace(/\./g, '').replace(',', '.'));
    if (!isFinite(reais) || reais <= 0) continue;
    out.push({ reais, index: m.index, raw, hasCurrency, hasDecimal });
  }
  return out;
}

// Acha o MAIOR valor numa linha que contenha a palavra TOTAL (ignorando
// "subtotal" / "total parcial" se possível — pegamos o maior mesmo).
function findTotalAmount(text) {
  const lines = text.split(/\r?\n/);
  let best = 0;
  for (const line of lines) {
    if (!/total/i.test(line)) continue;
    const vals = extractMoneyValues(line);
    for (const v of vals) if (v.reais > best) best = v.reais;
  }
  if (best > 0) return best;
  // Fallback: maior valor do documento inteiro (cuidado: pega 154,00 + 292,00 etc.,
  // o maior costuma ser o total mesmo em notas sem a palavra "TOTAL").
  const all = extractMoneyValues(text);
  for (const v of all) if (v.reais > best) best = v.reais;
  return best;
}

// Pega o título/emissor: 1ª linha não-vazia com letras maiúsculas (cabeçalhos
// de orçamento costumam ter o nome do estabelecimento em CAPS).
function detectIssuer(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 10)) {
    // 8+ chars, predominantemente maiúsculas, sem só números
    if (line.length >= 6 && line.length <= 80 && /[A-Z]/.test(line)) {
      const upper = (line.match(/[A-Z]/g) || []).length;
      const total = (line.match(/[A-Za-z]/g) || []).length;
      if (total > 4 && upper / total > 0.6) return line;
    }
  }
  // Fallback: primeira linha não vazia
  return lines[0] || '';
}

// Procura "Nº/Número do orçamento", "Pedido", "Nota nº" etc.
// Exige a palavra "numero/orcamento/pedido/nota" PRÓXIMA ao número pra não
// confundir com "Ano: 2024" ou similares.
function detectQuoteNumber(text) {
  // Procura padrão "<palavra-chave> ... <digits>" na MESMA linha
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/\b(?:n[°ºo.]?\s+|n[°º]\s*|numero|n[uú]mero|orca?mento|or[çc]amento|pedido|nota\s*fiscal|nota\s+n)\D{0,20}([0-9]{3,8})\b/i);
    if (m) return m[1];
  }
  return null;
}

// Extrai LINHAS DE ITEM: linhas que têm uma descrição + um valor no fim.
// Filtra TOTAL/SUBTOTAL/cabeçalhos. Usado pra montar a descrição rica do custo.
function extractLineItems(text) {
  const items = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.length < 4) continue;
    // Pula linhas-resumo
    if (/\b(total|subtotal|sub\.\s*total|forma\s+de\s+pagamento)\b/i.test(line)) continue;
    // Pula cabeçalhos típicos (linhas só com rótulos)
    if (/^(pe[çc]as?|servi[çc]o|valor|qtd|quantidade|descri[çc][aã]o|m[aã]o\s+de\s+obra)\s*[:\-]?\s*$/i.test(line)) continue;
    // Pula linhas de cabeçalho / dados de empresa
    if (/^(end\.?|cnpj|e[\-\s]?mail|tel|telefone|cep|cliente|contato|data|placa|cor|ano|ve[íi]culo|tempo de servi[çc]o|forma de pagamento|n[uú]mero do or[çc]amento)\b/i.test(line)) continue;
    // Pula linhas que CONTÊM (não só começam com) padrão claro de telefone,
    // CNPJ, email ou CEP — esses não são item de orçamento.
    if (/\(\d{2}\)\s*\d{4,5}[\s-]?\d{4}/.test(line)) continue;   // telefone (XX) 99999-9999
    if (/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/.test(line)) continue; // CNPJ 00.000.000/0000-00
    if (/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(line)) continue;        // CPF
    if (/\b[\w.+-]+@[\w-]+\.[\w.-]+/.test(line)) continue;       // email
    if (/\b\d{5}-\d{3}\b/.test(line)) continue;                  // CEP
    if (/\bCNPJ\b|\bCPF\b|\bCEP\b/i.test(line)) continue;        // se aparecer a palavra
    const vals = extractMoneyValues(line);
    if (vals.length === 0) continue;
    // Texto da "descrição" = tudo ANTES do último valor
    const lastVal = vals[vals.length - 1];
    let before = line.slice(0, lastVal.index)
      .replace(/[•\-:R\$\s]+$/, '')  // limpa lixo no fim
      .replace(/^[•\-*●▪◦·]\s*/, '') // bullet no começo (caracteres comuns)
      // OCR frequentemente lê "•" como "e " antes de uma palavra capitalizada.
      // Tira esse "e " sem afetar palavras legítimas como "espelho retrovisor".
      .replace(/^e\s+(?=[A-ZÀ-Ý])/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (before.length < 3) continue;
    // Se a linha era basicamente só números/datas, pula
    if (!/[A-Za-zÀ-ÿ]{3}/.test(before)) continue;
    items.push({
      text: before,
      value: lastVal.reais,
      category: detectCategory(before) || 'Outros'
    });
  }
  return items;
}

// === MAIN: extrai texto + sugere campos do custo ===
async function extractCostFromBuffer(buffer, mime) {
  let text = '';
  if (mime === 'application/pdf') {
    text = await ocrPdf(buffer);
  } else if (/^image\//.test(mime)) {
    text = await ocrImage(buffer);
  } else {
    throw new Error('Tipo não suportado: ' + mime);
  }
  const amount = findTotalAmount(text);
  const category = detectCategory(text);
  const issuer = detectIssuer(text);
  const quote = detectQuoteNumber(text);
  const rawItems = extractLineItems(text);

  // Normaliza items pra o formato que o frontend usa no batch:
  // { category, description, amount }. Cada um vira um custo separado.
  const items = rawItems.slice(0, 20).map(it => ({
    category: it.category || category || 'Outros',
    description: it.text,
    amount: it.value
  }));

  // Descrição "única" (fallback se não tiver itens claros): emissor + orçamento.
  let description = issuer || '';
  if (quote) description += (description ? ' · ' : '') + 'Orçamento ' + quote;
  if (!description) description = category;
  if (description.length > 280) description = description.slice(0, 277) + '...';

  return {
    amount,         // total geral (fallback se não tiver itens)
    category,       // categoria principal (fallback)
    description,    // descrição "única" (fallback)
    items,          // [{category, description, amount}] — cada um vira 1 custo
    issuer,
    quote,
    rawText: text.slice(0, 2000)
  };
}

async function ocrPdf(buffer) {
  const mupdf = await getMupdf();
  const worker = await getTesseract();
  const doc = mupdf.Document.openDocument(buffer, 'application/pdf');
  const pageCount = doc.countPages();
  const SCALE = 150 / 72;
  let allText = '';
  // Limita a 3 páginas pra não estourar memória em PDFs longos.
  const maxPages = Math.min(pageCount, 3);
  for (let i = 0; i < maxPages; i++) {
    const page = doc.loadPage(i);
    const pix = page.toPixmap(mupdf.Matrix.scale(SCALE, SCALE), mupdf.ColorSpace.DeviceRGB);
    const pngBuf = Buffer.from(pix.asPNG());
    const { data } = await worker.recognize(pngBuf);
    allText += (data && data.text ? data.text : '') + '\n';
  }
  return allText;
}

async function ocrImage(buffer) {
  const worker = await getTesseract();
  const { data } = await worker.recognize(buffer);
  return data && data.text ? data.text : '';
}

module.exports = { extractCostFromBuffer };
