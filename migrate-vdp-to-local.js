/**
 * MIGRAÇÃO: VDP Manus -> Banco local LancePrime
 *
 * Idempotente — pode rodar várias vezes sem duplicar (usa vdp_id como chave).
 * Migra: dados do veículo, fotos (array completo), custos individuais.
 *
 * Não toca em carros que NÃO vieram do VDP (ex: Virtus com vdp_id NULL).
 */

const { Pool } = require('pg');
const axios = require('axios');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const VDP_BASE = 'https://vendasdiretaspremium.manus.space';

async function loginVDP() {
  const res = await axios.post(VDP_BASE + '/api/trpc/auth.loginLocal',
    { json: { username: 'admin', password: 'admin' } },
    { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
  );
  const cookies = res.headers['set-cookie'];
  if (!cookies || cookies.length === 0) throw new Error('Login VDP falhou (sem cookies)');
  return cookies.map(c => c.split(';')[0]).join('; ');
}

async function fetchVDPVehicles(cookieHeader) {
  const res = await axios.get(VDP_BASE + '/api/trpc/vehicles.list?input=%7B%7D',
    { headers: { Cookie: cookieHeader }, timeout: 15000 }
  );
  return res.data?.result?.data?.json || [];
}

async function fetchVDPCosts(cookieHeader, vehicleId) {
  const input = encodeURIComponent(JSON.stringify({ json: { vehicleId } }));
  const res = await axios.get(VDP_BASE + '/api/trpc/costs.list?input=' + input,
    { headers: { Cookie: cookieHeader }, timeout: 15000 }
  );
  return res.data?.result?.data?.json || [];
}

function normalizePhotoUrl(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('/')) return VDP_BASE + url;
  return VDP_BASE + '/' + url;
}

async function ensureSchema() {
  console.log('[1/5] Verificando schema do banco...');

  // Colunas extras na tabela purchases pra suportar dados do VDP
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS vdp_id INTEGER`);
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS purchase_date DATE`);
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS doors INTEGER`);
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS photos TEXT`);
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS description TEXT`);
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS dealers_code VARCHAR(50)`);
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS dealers_uuid VARCHAR(100)`);
  await pool.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS laudo TEXT`);

  // Índice único pra UPSERT por vdp_id (NULL é permitido — Virtus tem vdp_id NULL)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS purchases_vdp_id_unique ON purchases(vdp_id) WHERE vdp_id IS NOT NULL`);

  // Tabela nova pra custos individuais
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicle_costs (
      id SERIAL PRIMARY KEY,
      vehicle_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      category VARCHAR(100),
      description TEXT,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      cost_date DATE,
      vdp_cost_id INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS vehicle_costs_vdp_id_unique ON vehicle_costs(vdp_cost_id) WHERE vdp_cost_id IS NOT NULL`);

  console.log('     Schema OK\n');
}

async function migrateVehicle(cookieHeader, v) {
  const photos = (v.photos || []).map(normalizePhotoUrl).filter(Boolean);
  const cover = normalizePhotoUrl(v.coverPhotoUrl) || photos[0] || null;
  const purchaseDate = v.purchaseDate ? v.purchaseDate.split('T')[0] : null;

  // UPSERT por vdp_id
  const upsert = await pool.query(`
    INSERT INTO purchases (
      vdp_id, brand, model, version, year, km, color, doors,
      fuel, transmission, city, status, notes,
      price, sell_price, fipe_price,
      image, photos, purchase_date
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13,
      $14, $15, $16,
      $17, $18, $19
    )
    ON CONFLICT (vdp_id) WHERE vdp_id IS NOT NULL
    DO UPDATE SET
      brand = EXCLUDED.brand,
      model = EXCLUDED.model,
      version = EXCLUDED.version,
      year = EXCLUDED.year,
      km = EXCLUDED.km,
      color = EXCLUDED.color,
      doors = EXCLUDED.doors,
      fuel = EXCLUDED.fuel,
      transmission = EXCLUDED.transmission,
      city = EXCLUDED.city,
      status = EXCLUDED.status,
      notes = EXCLUDED.notes,
      price = EXCLUDED.price,
      fipe_price = EXCLUDED.fipe_price,
      image = EXCLUDED.image,
      photos = EXCLUDED.photos,
      purchase_date = EXCLUDED.purchase_date
    RETURNING id, (xmax = 0) AS inserted
  `, [
    v.id,
    v.brand || '',
    v.model || '',
    v.version || '',
    String(v.year || ''),
    parseInt(v.mileage) || 0,
    v.color || '',
    v.doors || null,
    v.fuel || '',
    v.transmission || '',
    v.city || '',
    v.status || 'disponivel',
    v.notes || `Migrado do VDP (id ${v.id})`,
    parseFloat(v.purchasePrice) || 0,
    0, // sell_price — VDP não tem
    parseFloat(v.fipePrice) || 0,
    cover,
    JSON.stringify(photos),
    purchaseDate
  ]);

  const localId = upsert.rows[0].id;
  const wasInserted = upsert.rows[0].inserted;

  // Migrar custos do VDP
  let costsMigrated = 0;
  try {
    const vdpCosts = await fetchVDPCosts(cookieHeader, v.id);
    for (const c of vdpCosts) {
      // UPSERT por vdp_cost_id pra ser idempotente
      const r = await pool.query(`
        INSERT INTO vehicle_costs (vehicle_id, category, description, amount, cost_date, vdp_cost_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (vdp_cost_id) WHERE vdp_cost_id IS NOT NULL
        DO UPDATE SET
          vehicle_id = EXCLUDED.vehicle_id,
          category = EXCLUDED.category,
          description = EXCLUDED.description,
          amount = EXCLUDED.amount,
          cost_date = EXCLUDED.cost_date
        RETURNING id
      `, [
        localId,
        c.category || 'outros',
        c.description || '',
        parseFloat(c.amount) || 0,
        c.date ? c.date.split('T')[0] : null,
        c.id
      ]);
      if (r.rowCount > 0) costsMigrated++;
    }
  } catch (err) {
    console.log(`     [aviso] erro ao buscar custos do VDP id ${v.id}: ${err.message}`);
  }

  return { localId, action: wasInserted ? 'INSERIDO' : 'ATUALIZADO', photos: photos.length, costs: costsMigrated };
}

async function main() {
  try {
    console.log('====================================================');
    console.log('  MIGRAÇÃO VDP MANUS → BANCO LOCAL LANCEPRIME');
    console.log('====================================================\n');

    await ensureSchema();

    console.log('[2/5] Login no VDP Manus...');
    const cookieHeader = await loginVDP();
    console.log('     Login OK\n');

    console.log('[3/5] Listando veículos do VDP...');
    const vehicles = await fetchVDPVehicles(cookieHeader);
    console.log(`     ${vehicles.length} veículo(s) encontrado(s)\n`);

    if (vehicles.length === 0) {
      console.log('Nada pra migrar.');
      return;
    }

    console.log('[4/5] Migrando veículos e custos...\n');
    const results = [];
    for (const v of vehicles) {
      try {
        const r = await migrateVehicle(cookieHeader, v);
        console.log(`     [${r.action}] vdp:${v.id} → local:${r.localId} | ${v.brand} ${v.model} ${v.year} | ${r.photos} fotos | ${r.costs} custos`);
        results.push({ vdp_id: v.id, ...r, ok: true });
      } catch (err) {
        console.log(`     [ERRO] vdp:${v.id} ${v.brand} ${v.model}: ${err.message}`);
        results.push({ vdp_id: v.id, ok: false, error: err.message });
      }
    }

    console.log('\n[5/5] Resumo:');
    const inserted = results.filter(r => r.action === 'INSERIDO').length;
    const updated = results.filter(r => r.action === 'ATUALIZADO').length;
    const errors = results.filter(r => !r.ok).length;
    const totalPhotos = results.reduce((s, r) => s + (r.photos || 0), 0);
    const totalCosts = results.reduce((s, r) => s + (r.costs || 0), 0);

    console.log(`     Inseridos:  ${inserted}`);
    console.log(`     Atualizados: ${updated}`);
    console.log(`     Erros:      ${errors}`);
    console.log(`     Fotos migradas: ${totalPhotos}`);
    console.log(`     Custos migrados: ${totalCosts}`);

    console.log('\n=== ESTADO FINAL DO BANCO LOCAL ===');
    const final = await pool.query(`
      SELECT p.id, p.vdp_id, p.brand, p.model, p.year, p.price,
             COALESCE(json_array_length(p.photos::json), 0) as foto_count,
             (SELECT COUNT(*) FROM vehicle_costs WHERE vehicle_id = p.id) as custo_count
      FROM purchases p ORDER BY p.id
    `);
    final.rows.forEach(v => {
      const origem = v.vdp_id ? `VDP:${v.vdp_id}` : 'LOCAL';
      console.log(`  [${v.id}] (${origem}) ${v.brand} ${v.model} ${v.year} - R$${parseFloat(v.price).toLocaleString()} - ${v.foto_count} fotos - ${v.custo_count} custos`);
    });

    console.log('\n✓ Migração concluída.');

  } catch (err) {
    console.error('\n✗ ERRO FATAL:', err.message);
    if (err.response) console.error('  Status:', err.response.status, 'Data:', JSON.stringify(err.response.data).substring(0, 300));
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
