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
      created_at TIMESTAMP DEFAULT NOW(),
      dealer_id INTEGER,
      plate VARCHAR(20),
      location VARCHAR(255),
      comitente VARCHAR(255),
      photos TEXT,
      fuel VARCHAR(50),
      transmission VARCHAR(50),
      doors INTEGER,
      engine VARCHAR(100)
    )
  `);

  const columns = [
    { name: 'dealer_id', type: 'INTEGER' },
    { name: 'plate', type: 'VARCHAR(20)' },
    { name: 'location', type: 'VARCHAR(255)' },
    { name: 'comitente', type: 'VARCHAR(255)' },
    { name: 'photos', type: 'TEXT' },
    { name: 'fuel', type: 'VARCHAR(50)' },
    { name: 'transmission', type: 'VARCHAR(50)' },
    { name: 'doors', type: 'INTEGER' },
    { name: 'engine', type: 'VARCHAR(100)' }
  ];

  for (const col of columns) {
    await pool.query(`
      ALTER TABLE purchases ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}
    `).catch(() => {});
  }
}

module.exports = { pool, initDB };
