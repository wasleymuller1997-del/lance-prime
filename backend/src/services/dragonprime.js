// Integração com o portal do fornecedor Dragon Prime (cliente.dragonprime.com.br).
// A API deles é tRPC em /api/trpc: login por usuário+senha (sessão em cookie) e
// o catálogo B2B de pronta entrega vem de bFornecedor.catalogo / .disponivel.
//
// Credenciais ficam SÓ em variáveis de ambiente (nunca no código):
//   DRAGON_USER  — usuário do login (o que aparece em "Digite seu usuário")
//   DRAGON_PASS  — senha

const BASE = process.env.DRAGON_BASE_URL || 'https://cliente.dragonprime.com.br';

function configured() {
  return Boolean(process.env.DRAGON_USER && process.env.DRAGON_PASS);
}

async function login() {
  const resp = await fetch(`${BASE}/api/trpc/auth.login?batch=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 0: { json: { username: process.env.DRAGON_USER, senha: process.env.DRAGON_PASS } } }),
  });
  // getSetCookie existe no fetch nativo do Node 18.14+; junta todos os cookies da sessão.
  const cookies = (resp.headers.getSetCookie ? resp.headers.getSetCookie() : [])
    .map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  const body = await resp.json().catch(() => null);
  const err = Array.isArray(body) && body[0] && body[0].error;
  if (!resp.ok || err) {
    const msg = (err && err.json && err.json.message) || `HTTP ${resp.status}`;
    throw new Error(`Login Dragon Prime falhou: ${msg}`);
  }
  if (!cookies) throw new Error('Login Dragon Prime não retornou cookie de sessão');
  return cookies;
}

// Desembrulha resposta tRPC (com ou sem superjson): [{result:{data:{json:X}}}] → X
function unwrap(body) {
  const r = Array.isArray(body) ? body[0] : body;
  if (r && r.error) {
    const msg = (r.error.json && r.error.json.message) || 'erro tRPC';
    throw new Error(`Dragon Prime: ${msg}`);
  }
  const data = r && r.result && r.result.data;
  return data && typeof data === 'object' && 'json' in data ? data.json : data;
}

async function query(proc, cookies) {
  // Procedures sem input: primeiro sem o parâmetro; se o schema reclamar, tenta com json:null.
  const urls = [
    `${BASE}/api/trpc/${proc}?batch=1`,
    `${BASE}/api/trpc/${proc}?batch=1&input=${encodeURIComponent('{"0":{"json":null}}')}`,
  ];
  let lastErr = null;
  for (const url of urls) {
    try {
      const resp = await fetch(url, { headers: { Cookie: cookies } });
      const body = await resp.json().catch(() => null);
      if (body == null) throw new Error(`HTTP ${resp.status} sem JSON`);
      return unwrap(body);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Acha o array de itens mesmo que venha embrulhado ({itens:[...]}, {produtos:[...]}, etc).
function findItems(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of ['itens', 'items', 'produtos', 'catalogo', 'aparelhos', 'lista', 'data', 'rows']) {
      if (Array.isArray(data[k])) return data[k];
    }
    for (const v of Object.values(data)) if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  return null;
}

// Normaliza um item do catálogo pro formato da wm_products.
function normalize(raw, idx) {
  const pick = (...keys) => {
    for (const k of keys) if (raw[k] != null && raw[k] !== '') return raw[k];
    return null;
  };
  const modelo = pick('modelo', 'nome', 'name', 'descricao', 'produto') || `Item ${idx + 1}`;
  const detalhes = [pick('capacidade', 'memoria'), pick('cor', 'color'), pick('estado', 'condicao')]
    .filter(Boolean).join(' · ');
  const preco = Number(pick('preco', 'precoVenda', 'valor', 'price')) || 0;
  const qtd = Number(pick('qtd', 'quantidade', 'disponivel', 'estoque')) || 0;
  const ref = pick('id', 'sku', 'codigo');
  return {
    supplier_ref: ref != null ? `dragon:${ref}` : `dragon:${modelo}|${detalhes}`.slice(0, 100),
    name: String(detalhes ? `${modelo} ${pick('capacidade', 'memoria') || ''}`.trim() : modelo).slice(0, 255),
    description: detalhes || null,
    cost: preco,
    stock: Math.max(0, Math.round(qtd)),
    image: pick('imagem', 'foto', 'image', 'imagemUrl', 'fotoUrl') || null,
    raw,
  };
}

// Busca o catálogo de pronta entrega e devolve itens normalizados.
async function fetchCatalog() {
  if (!configured()) throw new Error('Integração Dragon Prime não configurada (defina DRAGON_USER e DRAGON_PASS no .env)');
  const cookies = await login();
  let data;
  try {
    data = await query('bFornecedor.catalogo', cookies);
  } catch (e) {
    // fallback: alguns perfis só enxergam o "disponível"
    data = await query('bFornecedor.disponivel', cookies);
  }
  const items = findItems(data);
  if (!items) {
    const sample = JSON.stringify(data).slice(0, 400);
    throw new Error(`Formato inesperado do catálogo Dragon Prime — amostra: ${sample}`);
  }
  return items.map(normalize);
}

module.exports = { configured, fetchCatalog };
