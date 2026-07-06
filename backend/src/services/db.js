const { Pool } = require('pg');

// SSL: bancos managed (Render/Railway/Neon/Supabase/Heroku) exigem SSL.
// Localhost geralmente roda sem SSL.
const isLocalDb = process.env.DATABASE_URL && /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      brand VARCHAR(255),
      model VARCHAR(255),
      version VARCHAR(255),
      year VARCHAR(50),
      km INTEGER DEFAULT 0,
      color VARCHAR(100),
      price NUMERIC DEFAULT 0,
      sell_price NUMERIC DEFAULT 0,
      status VARCHAR(50) DEFAULT 'disponivel',
      notes TEXT,
      fuel VARCHAR(100),
      transmission VARCHAR(100),
      city VARCHAR(255),
      image TEXT,
      fipe_price NUMERIC DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Adicionar colunas se não existirem (para bancos existentes)
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS fuel VARCHAR(100)`).catch(() => {});
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS transmission VARCHAR(100)`).catch(() => {});
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS city VARCHAR(255)`).catch(() => {});
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS image TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS fipe_price NUMERIC DEFAULT 0`).catch(() => {});
  // Venda: dados de fechamento (sale_price é o que de fato foi vendido — diferente
  // do FIPE/sell_price especulativo). down_payment + balance_due_date documentam
  // a estrutura da venda; os recebimentos parciais ficam em vehicle_receipts.
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS sale_price NUMERIC`).catch(() => {});
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS sold_date DATE`).catch(() => {});
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS buyer_name VARCHAR(255)`).catch(() => {});
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS buyer_phone VARCHAR(50)`).catch(() => {});
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS down_payment NUMERIC DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS balance_due_date DATE`).catch(() => {});
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50)`).catch(() => {});
  // Recebimentos parciais do saldo: o cliente pode pagar a entrada agora e o
  // saldo em 1 ou várias parcelas, cada uma vira uma linha aqui.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicle_receipts (
      id SERIAL PRIMARY KEY,
      vehicle_id INTEGER NOT NULL,
      amount NUMERIC NOT NULL,
      received_date DATE NOT NULL,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vehicle_receipts_vehicle_id ON vehicle_receipts(vehicle_id)`).catch(() => {});
  // Parcelamento: paid=false = parcela AGENDADA (recebe no futuro), true = ja recebida.
  // Default true pra nao quebrar registros antigos (todos contam como recebidos).
  await pool.query(`ALTER TABLE vehicle_receipts ADD COLUMN IF NOT EXISTS paid BOOLEAN DEFAULT TRUE`).catch(() => {});
  // Tabela de custos por veículo (já existia no banco mas formalizamos aqui).
  // attachment_* guardam o comprovante (PDF/imagem) anexado ao custo — útil pra
  // auditoria e pra mostrar o original que originou aquela despesa.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicle_costs (
      id SERIAL PRIMARY KEY,
      vehicle_id INTEGER NOT NULL,
      category VARCHAR(100),
      description TEXT,
      amount NUMERIC NOT NULL,
      cost_date DATE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE vehicle_costs ADD COLUMN IF NOT EXISTS attachment_data BYTEA`).catch(() => {});
  await pool.query(`ALTER TABLE vehicle_costs ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(80)`).catch(() => {});
  await pool.query(`ALTER TABLE vehicle_costs ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255)`).catch(() => {});
  // Anexo compartilhado: quando um único PDF/foto gera N custos (ex.: orçamento
  // do mecânico com 5 itens), guardamos UMA vez aqui e cada custo só referencia.
  // Evita duplicar 3MB de PNG 5 vezes no banco + na rede.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cost_attachments (
      id SERIAL PRIMARY KEY,
      data BYTEA NOT NULL,
      mime VARCHAR(80),
      name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE vehicle_costs ADD COLUMN IF NOT EXISTS attachment_id INTEGER`).catch(() => {});
  // Laudo cautelar PDF: o lojista pode anexar manualmente caso o carro tenha
  // sido cadastrado sem laudo. Stored direto no banco como BYTEA — mesmo padrão
  // dos anexos de custo.
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS laudo_data BYTEA`).catch(() => {});
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS laudo_mime VARCHAR(80)`).catch(() => {});
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS laudo_name VARCHAR(255)`).catch(() => {});
  // Fotos próprias do lojista — substituem as da Dealers (geralmente fotos do
  // pátio, antes da entrega). Quando o carro chega na loja, o lojista fotografa
  // de novo e essas viram as fotos "oficiais" no estoque + vitrine pública.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicle_photos_custom (
      id SERIAL PRIMARY KEY,
      vehicle_id INTEGER NOT NULL,
      data BYTEA NOT NULL,
      mime VARCHAR(80),
      display_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vehicle_photos_custom_vehicle_id ON vehicle_photos_custom(vehicle_id)`).catch(() => {});

  // Insumos/custos de estoque AVULSOS: comprados sem carro ainda (ex: 6 pneus,
  // pecas, material). Ficam num "almoxarifado" ate serem alocados num veiculo.
  // remaining_qty controla quanto ainda esta em estoque (baixa a cada alocacao).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_items (
      id SERIAL PRIMARY KEY,
      category VARCHAR(100),
      description TEXT,
      quantity NUMERIC DEFAULT 1,
      unit_amount NUMERIC DEFAULT 0,
      total_amount NUMERIC DEFAULT 0,
      remaining_qty NUMERIC DEFAULT 0,
      cost_date DATE DEFAULT CURRENT_DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Historico de alocacao: cada vez que parte de um insumo vira custo de um
  // carro, registramos aqui (com o vehicle_cost_id gerado) pra poder desfazer.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_allocations (
      id SERIAL PRIMARY KEY,
      stock_item_id INTEGER NOT NULL,
      vehicle_id INTEGER NOT NULL,
      vehicle_cost_id INTEGER,
      quantity NUMERIC DEFAULT 1,
      amount NUMERIC DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Geracoes da aba Marketing (Claude API). Salva pra nao pagar a mesma
  // coisa duas vezes e dar historico ao lojista.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketing_generations (
      id SERIAL PRIMARY KEY,
      type VARCHAR(80) NOT NULL,
      label VARCHAR(200),
      params JSONB,
      output TEXT NOT NULL,
      model VARCHAR(80),
      tokens_in INTEGER,
      tokens_out INTEGER,
      ms INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_marketing_generations_type ON marketing_generations(type, created_at DESC)`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      phone VARCHAR(50),
      cpf VARCHAR(20),
      password VARCHAR(255) NOT NULL,
      approved BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Campos extras de perfil (cadastro completo). ADD COLUMN IF NOT EXISTS pra
  // não quebrar bancos já existentes.
  const userCols = [
    `birth_date DATE`,
    `person_type VARCHAR(10) DEFAULT 'fisica'`,
    `cnpj VARCHAR(20)`,
    `company_name VARCHAR(255)`,
    `cep VARCHAR(12)`,
    `street VARCHAR(255)`,
    `number VARCHAR(20)`,
    `complement VARCHAR(120)`,
    `neighborhood VARCHAR(120)`,
    `city VARCHAR(120)`,
    `uf VARCHAR(2)`,
    // Auditoria do aceite dos termos: timestamp + versao + IP. Necessario pra
    // ter prova em caso de disputa sobre se o usuario aceitou os termos.
    `terms_accepted_at TIMESTAMP`,
    `terms_version VARCHAR(20)`,
    `terms_accepted_ip VARCHAR(45)`,
    // Bloqueio: distingue "cliente bloqueado" de "cadastro ainda pendente".
    // Ambos ficam com approved=false, mas blocked=true significa que o admin
    // bloqueou de propria vontade (aparece na lista de Bloqueados).
    `blocked BOOLEAN DEFAULT FALSE`
  ];
  for (const col of userCols) {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }
  // Documentos do cliente (RG/CNH/comprovante) guardados no banco (BYTEA),
  // mesmo esquema do laudo — sem depender de storage externo.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_documents (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doc_type VARCHAR(40),
      filename VARCHAR(255),
      mime VARCHAR(80),
      data BYTEA,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Status de aprovacao do documento pelo admin. Bid endpoint exige
  // >= 1 doc verified=TRUE — subir nao basta, tem que ser aprovado.
  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS verified_by VARCHAR(80)`).catch(() => {});
  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS rejected_reason TEXT`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hidden_vehicles (
      id SERIAL PRIMARY KEY,
      vehicle_id INTEGER NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Persiste os eventos vistos da Dealers pra sobreviver a restart do servidor.
  // Sem isso, o cache em memória sumia a cada deploy e eventos encerrados (que
  // a Dealers tira do feed) desapareciam do site antes da janela de 3h.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events_cache (
      id INTEGER PRIMARY KEY,
      raw JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Mapeia ID opaco -> URL real da imagem. Permite servir imagens externas
  // (CDN do fornecedor) via /api/img/<id> sem expor o domínio na URL pública.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS image_url_map (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bids (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      user_name VARCHAR(255),
      user_email VARCHAR(255),
      advertisement_id INTEGER,
      vehicle_brand VARCHAR(255),
      vehicle_model VARCHAR(255),
      bid_value NUMERIC NOT NULL,
      bid_type VARCHAR(50) DEFAULT 'manual',
      status VARCHAR(50) DEFAULT 'enviado',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Configuracoes globais da plataforma (key-value). Usado pra dados que mudam
  // raramente e que o admin precisa editar pela tela sem deploy — por ora
  // guarda os dados bancarios do dono pro cliente vencedor pagar sinal.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key VARCHAR(80) PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Resultado final + aprovacao do dono. Sem essas colunas, o status fica
  // "enviado" pra sempre e o sistema nao sabe quem ganhou quando o leilao
  // fecha. O cron de reconciliacao preenche outcome/final_price/won_at;
  // o admin aprova manualmente quando confere com a Dealers.
  await pool.query(`ALTER TABLE bids ADD COLUMN IF NOT EXISTS outcome VARCHAR(30)`).catch(() => {});
  await pool.query(`ALTER TABLE bids ADD COLUMN IF NOT EXISTS final_price NUMERIC`).catch(() => {});
  await pool.query(`ALTER TABLE bids ADD COLUMN IF NOT EXISTS auction_end_date TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE bids ADD COLUMN IF NOT EXISTS won_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE bids ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE bids ADD COLUMN IF NOT EXISTS admin_approved BOOLEAN`).catch(() => {});
  await pool.query(`ALTER TABLE bids ADD COLUMN IF NOT EXISTS admin_approved_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE bids ADD COLUMN IF NOT EXISTS admin_notes TEXT`).catch(() => {});
  // Prazo do pagamento do sinal (won_at OU auction_end_date + 5min). Quando
  // ultrapassado sem pagamento, a multa do item 4 dos termos se aplica.
  await pool.query(`ALTER TABLE bids ADD COLUMN IF NOT EXISTS payment_deadline TIMESTAMP`).catch(() => {});
  // Sinal recebido pelo admin (cliente pagou o PIX, admin viu o extrato e
  // confirmou). Antes disso a contagem regressiva de 5min roda; depois ela
  // para e o fluxo entra no estado "aguardando Dealers".
  await pool.query(`ALTER TABLE bids ADD COLUMN IF NOT EXISTS signal_paid BOOLEAN`).catch(() => {});
  await pool.query(`ALTER TABLE bids ADD COLUMN IF NOT EXISTS signal_paid_at TIMESTAMP`).catch(() => {});
  await pool.query(`ALTER TABLE bids ADD COLUMN IF NOT EXISTS notified_winner_at TIMESTAMP`).catch(() => {});
  // Snapshot do veiculo no momento do lance — sem isso, se a Dealers tirar o
  // anuncio do feed depois de fechado, perdemos o contexto pro cliente entender
  // o que comprou. Salvo como JSON (foto, ano, km, placa, etc.).
  await pool.query(`ALTER TABLE bids ADD COLUMN IF NOT EXISTS vehicle_snapshot JSONB`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bids_user_outcome ON bids(user_id, outcome)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bids_outcome_null ON bids(outcome) WHERE outcome IS NULL`).catch(() => {});
  // Lance que gerou a compra (bid vencedor -> purchases automatica).
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS bid_id INTEGER`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pix_cobrancas (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      user_name VARCHAR(255),
      user_email VARCHAR(255),
      txid VARCHAR(100) UNIQUE NOT NULL,
      valor NUMERIC(12,2) NOT NULL,
      descricao VARCHAR(500),
      tipo VARCHAR(50) DEFAULT 'sinal',
      status VARCHAR(50) DEFAULT 'ATIVA',
      pix_copia_cola TEXT,
      advertisement_id INTEGER,
      vehicle_info VARCHAR(255),
      paid_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicle_snapshots (
      id SERIAL PRIMARY KEY,
      advertisement_id INTEGER NOT NULL,
      event_id INTEGER,
      brand VARCHAR(255),
      model VARCHAR(255),
      version VARCHAR(255),
      year_manufacture INTEGER,
      year_model INTEGER,
      km INTEGER DEFAULT 0,
      color VARCHAR(100),
      fuel VARCHAR(100),
      transmission VARCHAR(100),
      bodywork VARCHAR(100),
      location VARCHAR(255),
      uf VARCHAR(5),
      comitente VARCHAR(255),
      plate VARCHAR(20),
      photos TEXT,
      fipe_value NUMERIC,
      fipe_model VARCHAR(255),
      fipe_score VARCHAR(10),
      description TEXT,
      initial_price NUMERIC,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(advertisement_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dealers_accounts (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100),
      email VARCHAR(200),
      password VARCHAR(200),
      shop_id VARCHAR(50),
      whitelabel_id VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fipe_cache (
      id SERIAL PRIMARY KEY,
      cache_key VARCHAR(500) UNIQUE NOT NULL,
      brand VARCHAR(255),
      model VARCHAR(255),
      version VARCHAR(255),
      year INTEGER,
      fipe_value NUMERIC,
      fipe_model VARCHAR(255),
      fipe_code VARCHAR(50),
      fipe_reference VARCHAR(100),
      match_score VARCHAR(10),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Cache persistente da lista de versões FIPE (modal "Atualizar FIPE").
  // Sobrevive a restarts — evita martelar a Parallelum e some com os 429.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fipe_versions_cache (
      cache_key VARCHAR(500) PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Cache permanente de laudos cautelares redacted (sem nome da Dealers).
  // Cada laudo é processado (OCR) uma vez; depois servido instantâneo daqui,
  // sobrevivendo a reinícios do servidor.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS laudo_cache (
      id SERIAL PRIMARY KEY,
      url_hash VARCHAR(64) UNIQUE NOT NULL,
      source_url TEXT,
      pdf_data BYTEA NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

module.exports = { pool, initDB };
