import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { query } from '../src/db.js';

const dir = path.resolve(process.cwd(), 'sql');

async function ensureTable() {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text primary key,
    applied_at timestamptz not null default now()
  )`);
}

async function applied(): Promise<Set<string>> {
  const res = await query<{filename: string}>(`SELECT filename FROM schema_migrations`);
  return new Set(res.rows.map(r => r.filename));
}

async function applyFile(file: string) {
  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  console.log("Applying", file);
  await query(sql);
  await query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
}

async function main() {
  await ensureTable();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const done = await applied();
  for (const f of files) {
    if (done.has(f)) continue;
    await applyFile(f);
  }
  console.log("Migrations complete.");
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
