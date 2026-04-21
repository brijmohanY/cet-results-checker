/**
 * build-pmt-shortlist.js
 *
 * Parses the HSSC PMT shortlist PDF (result.pdf → result_shortlist.txt) and
 * populates a `pmt_shortlist` table in data.db.
 *
 * The table maps CET reg_no → post shortlisted for, so server.js can show
 * "Called for Physical — Male Constable (GD/GRP)" on the result screen.
 *
 * Usage:
 *   pdftotext -layout result.pdf result_shortlist.txt   # (run once if not done)
 *   node scripts/build-pmt-shortlist.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

const TXT_PATH = path.join(ROOT, 'result_shortlist.txt');
const DB_PATH  = path.join(ROOT, 'data.db');

// ─── 1. Extract text from PDF if txt not present ─────────────────────────────
if (!fs.existsSync(TXT_PATH)) {
  const pdfPath = path.join(ROOT, 'result.pdf');
  if (!fs.existsSync(pdfPath)) {
    console.error('❌ result.pdf not found in project root');
    process.exit(1);
  }
  console.log('📄 Extracting text from result.pdf...');
  const { execSync } = await import('child_process');
  execSync(`pdftotext -layout "${pdfPath}" "${TXT_PATH}"`, { stdio: 'pipe' });
  console.log('✓ result_shortlist.txt created\n');
}

// ─── 2. Parse the text file ───────────────────────────────────────────────────
console.log('🔍 Parsing shortlist...\n');

const text  = fs.readFileSync(TXT_PATH, 'utf8');
const lines = text.split('\n');

// Human-readable post name mapping from what appears in the PDF
const POST_LABEL = {
  'Male Constable (1)':            'Male Constable (General Duty)',
  'Government Railway Police (3)': 'Male Constable (Government Railway Police)',
};

let currentPost     = null;
let currentCategory = null;
let currentCutoff   = null;

const records = [];      // { reg_no, post, category, cutoff }
const seenKey = new Set(); // deduplicate reg_no+post combinations

for (const raw of lines) {
  const line = raw.trim();

  // Skip blanks and page markers
  if (!line || /^Page \d+ of \d+/.test(line)) continue;

  // ── Post header: "Post : Male Constable (1)"
  const postMatch = line.match(/^Post\s*:\s*(.+)$/);
  if (postMatch) {
    const rawPost = postMatch[1].trim();
    currentPost     = POST_LABEL[rawPost] ?? rawPost;
    currentCategory = null;
    currentCutoff   = null;
    continue;
  }

  // ── Category + cut-off: "Category: UR   Cut-off: 52.1796687"
  const catMatch = line.match(/^Category:\s*(.+?)\s{2,}Cut-off:\s*([0-9.]+)/);
  if (catMatch) {
    currentCategory = catMatch[1].trim();
    currentCutoff   = parseFloat(catMatch[2]);
    continue;
  }

  // ── Data rows: only numbers separated by whitespace
  if (!currentPost || !currentCategory) continue;

  const tokens = line.split(/\s+/);
  if (!tokens.every(t => /^\d+$/.test(t))) continue;

  for (const token of tokens) {
    const key = `${token}|${currentPost}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    records.push({
      reg_no:   token,
      post:     currentPost,
      category: currentCategory,
      cutoff:   currentCutoff,
    });
  }
}

console.log(`✓ Parsed ${records.length.toLocaleString()} shortlist entries\n`);

// Group summary
const byCat = {};
for (const r of records) {
  const k = `${r.post} / ${r.category}`;
  byCat[k] = (byCat[k] ?? 0) + 1;
}
for (const [k, n] of Object.entries(byCat)) {
  console.log(`  ${k}: ${n.toLocaleString()}`);
}
console.log();

// ─── 3. Write to data.db ─────────────────────────────────────────────────────
if (!fs.existsSync(DB_PATH)) {
  console.error(`❌ data.db not found. Run build-from-pdf.js first.`);
  process.exit(1);
}

console.log('🗄  Writing to data.db...');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Drop & recreate so re-runs are idempotent
db.exec(`
  DROP TABLE IF EXISTS pmt_shortlist;
  CREATE TABLE pmt_shortlist (
    id       INTEGER PRIMARY KEY,
    reg_no   TEXT NOT NULL,
    post     TEXT NOT NULL,
    category TEXT NOT NULL,
    cutoff   REAL
  );
  CREATE INDEX idx_pmt_reg_no ON pmt_shortlist(reg_no);
`);

const insert = db.prepare(
  'INSERT INTO pmt_shortlist (reg_no, post, category, cutoff) VALUES (@reg_no, @post, @category, @cutoff)'
);
const insertMany = db.transaction(rows => { for (const r of rows) insert.run(r); });

const BATCH = 50000;
for (let i = 0; i < records.length; i += BATCH) {
  insertMany(records.slice(i, i + BATCH));
}

db.pragma('optimize');
db.close();

console.log(`✓ pmt_shortlist table populated with ${records.length.toLocaleString()} rows\n`);
console.log('═══════════════════════════════════════════════════');
console.log('  PMT shortlist build complete');
console.log('  Restart the server to activate PMT lookup.');
console.log('═══════════════════════════════════════════════════\n');
