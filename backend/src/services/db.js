const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
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
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
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
}

module.exports = { pool, initDB };
