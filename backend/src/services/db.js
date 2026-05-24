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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hidden_vehicles (
      id SERIAL PRIMARY KEY,
      vehicle_id INTEGER NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
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
