/**
 * build-from-pdf.js
 *
 * Rebuilds data.db (SQLite) fresh from the merged CET PDF.
 *
 * Steps:
 *  1. Extract text from PDF using pdftotext -layout (preserves table columns)
 *  2. Parse every record (all statuses: Qualified / Not Qualified / Absent / Result Withheld)
 *  3. Deduplicate by Roll No. (keep first occurrence)
 *  4. Compute overall rank  — Qualified candidates only, sorted marks DESC (ties share a rank)
 *  5. Compute category rank — same within each category
 *  6. Write a NEW data-new.db (so old data.db is untouched until this succeeds)
 *  7. Atomically rename data-new.db → data.db
 *
 * Usage:
 *   node scripts/build-from-pdf.js
 *
 * Requires: poppler (pdftotext) and better-sqlite3
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PDFS_DIR = path.join(ROOT, 'pdfs');
const DB_NEW   = path.join(ROOT, 'data-new.db');
const DB_PATH  = path.join(ROOT, 'data.db');

// ─── 1. Find all PDFs ────────────────────────────────────────────────────────
const pdfFiles = fs.readdirSync(PDFS_DIR)
  .filter(f => f.endsWith('.pdf'))
  .sort()
  .map(f => path.join(PDFS_DIR, f));

if (pdfFiles.length === 0) {
  console.error(`❌ No PDFs found in ${PDFS_DIR}`);
  process.exit(1);
}

console.log(`📂 Found ${pdfFiles.length} PDF files in pdfs/\n`);

// ─── 2. Extract + parse all PDFs ────────────────────────────────────────────
console.log('🔍 Parsing records…\n');

const totalStart = Date.now();
let lines = [];

for (let i = 0; i < pdfFiles.length; i++) {
  const pdf = pdfFiles[i];
  const name = path.basename(pdf);
  const txtPath = pdf.replace('.pdf', '.txt');

  process.stdout.write(`  [${i+1}/${pdfFiles.length}] ${name} — extracting... `);
  const t = Date.now();
  execSync(`pdftotext -layout "${pdf}" "${txtPath}"`, { stdio: 'pipe' });
  const secs = ((Date.now() - t) / 1000).toFixed(1);

  const fileLines = fs.readFileSync(txtPath, 'utf8').split('\n');
  lines = lines.concat(fileLines);
  process.stdout.write(`${secs}s, ${fileLines.length.toLocaleString()} lines\n`);
}

console.log(`\n✓ All PDFs extracted in ${((Date.now() - totalStart) / 1000).toFixed(1)}s\n`);

/**
 * Each data line looks like (fixed-width columns from -layout):
 *   5215005011   20251261091   GEN   -   -   56.7086292   Qualified
 *
 * Columns:
 *   roll_no  (52XXXXXXXX, 10 digits)
 *   reg_no   (variable-length numeric)
 *   category (GEN|OSC|BCA|BCB|DSC|EWS …)
 *   sub_cat  (- or text like "Dependent of ESM")
 *   pwd      (- or OH|HH|VH|Y|N …)
 *   marks    (decimal, possibly negative, or -)
 *   status   (Qualified | Not Qualified | Absent | Result Withheld)
 */
const ROW_RE = /^\s*(5\d{9})\s+(\S+)\s+([A-Z]{2,5})\s+(.*?)\s+(\S+)\s+(-?-?\d*\.?\d+|-)\s+(Qualified|Not Qualified|Absent|Result Withheld)\s*$/;

const records = [];
const seenRolls = new Set();
let skipped = 0;

for (const line of lines) {
  const s = line.trim();
  if (!s || s.includes('DETAIL RESULT') || s.startsWith('Roll No.') || /^Page \d+ of \d+/.test(s)) continue;

  const m = line.match(ROW_RE);
  if (!m) continue;

  const [, roll_no, reg_no, category, sub_cat, pwd, marks_raw, status] = m;

  if (seenRolls.has(roll_no)) { skipped++; continue; }
  seenRolls.add(roll_no);

  records.push({
    roll_no:  roll_no.trim(),
    reg_no:   reg_no.trim(),
    category: category.trim(),
    sub_cat:  sub_cat.trim(),
    pwd:      pwd.trim(),
    marks:    (marks_raw === '-' || marks_raw === '') ? null : parseFloat(marks_raw),
    status:   status.trim(),
    rank:     null,   // computed below
    cat_rank: null,   // computed below
  });
}

console.log(`✓ Parsed ${records.length.toLocaleString()} records (${skipped} duplicates skipped)\n`);

// ─── 3. Compute ranks ────────────────────────────────────────────────────────
console.log('📊 Computing overall rank and category rank…');

// Only Qualified candidates receive a rank
const qualified = records.filter(r => r.status === 'Qualified');

// Sort by marks DESC (higher marks = better rank)
qualified.sort((a, b) => (b.marks ?? -Infinity) - (a.marks ?? -Infinity));

// Assign overall rank (ties share the same rank)
let rank = 0, prev = null, tieStart = 0;
for (let i = 0; i < qualified.length; i++) {
  const m = qualified[i].marks;
  if (m !== prev) { rank = i + 1; prev = m; }
  qualified[i].rank = rank;
}

// Category rank: within each category, sort by marks DESC
const byCategory = {};
for (const r of qualified) {
  (byCategory[r.category] ??= []).push(r);
}
for (const [cat, group] of Object.entries(byCategory)) {
  // already sorted marks DESC (they're a subset of the globally sorted array)
  let cRank = 0, cPrev = null;
  for (let i = 0; i < group.length; i++) {
    const m = group[i].marks;
    if (m !== cPrev) { cRank = i + 1; cPrev = m; }
    group[i].cat_rank = cRank;
  }
}

const maxRank = qualified.length > 0 ? qualified[qualified.length - 1].rank : 0;
console.log(`✓ Overall rank 1–${maxRank.toLocaleString()} assigned to ${qualified.length.toLocaleString()} Qualified candidates`);

const catSummary = Object.entries(byCategory).map(([c, g]) => `${c}:${g.length}`).join(' | ');
console.log(`✓ Category ranks assigned — ${catSummary}\n`);

// ─── 4. Build SQLite DB ──────────────────────────────────────────────────────
console.log('🗄  Building SQLite database…');

if (fs.existsSync(DB_NEW)) fs.unlinkSync(DB_NEW);

const db = new Database(DB_NEW);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -64000');

db.exec(`
  CREATE TABLE results (
    id        INTEGER PRIMARY KEY,
    roll_no   TEXT,
    reg_no    TEXT,
    rank      INTEGER,
    cat_rank  INTEGER,
    marks     REAL,
    category  TEXT,
    sub_cat   TEXT,
    pwd       TEXT,
    status    TEXT
  );
  CREATE INDEX idx_roll_no  ON results(roll_no);
  CREATE INDEX idx_reg_no   ON results(reg_no);
  CREATE INDEX idx_cat_rank ON results(category, rank);
`);

const insert = db.prepare(`
  INSERT INTO results (roll_no, reg_no, rank, cat_rank, marks, category, sub_cat, pwd, status)
  VALUES (@roll_no, @reg_no, @rank, @cat_rank, @marks, @category, @sub_cat, @pwd, @status)
`);

const insertMany = db.transaction((rows) => {
  for (const r of rows) insert.run(r);
});

const BATCH = 50000;
let done = 0;
for (let i = 0; i < records.length; i += BATCH) {
  insertMany(records.slice(i, i + BATCH));
  done += Math.min(BATCH, records.length - i);
  process.stdout.write(`  ${done.toLocaleString()} / ${records.length.toLocaleString()}\r`);
}

db.pragma('optimize');
db.close();

const sizeMB = (fs.statSync(DB_NEW).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ data-new.db built (${sizeMB} MB)\n`);

// ─── 5. Generate ranks-marks chart ──────────────────────────────────────────
console.log('📈 Generating ranks-marks chart…');

const RANGE = 5000;
const MAX_RANK = 100000;
const chart = [];

for (let start = 1; start <= MAX_RANK; start += RANGE) {
  const end = Math.min(start + RANGE - 1, MAX_RANK);
  const slice = qualified.filter(r => r.rank >= start && r.rank <= end);
  if (slice.length === 0) continue;
  const marksArr = slice.map(r => r.marks).sort((a, b) => b - a);
  chart.push({
    rankRange:  `${start.toLocaleString()}-${end.toLocaleString()}`,
    minMarks:   marksArr[marksArr.length - 1].toFixed(1),
    maxMarks:   marksArr[0].toFixed(1),
    avgMarks:   (marksArr.reduce((a, b) => a + b, 0) / marksArr.length).toFixed(1),
    candidates: slice.length,
  });
}

const chartPath = path.join(ROOT, 'ranks-marks.json');
fs.writeFileSync(chartPath, JSON.stringify(chart, null, 2));
console.log(`✓ ranks-marks.json saved (${chart.length} ranges)\n`);

// ─── 6. Atomic swap ──────────────────────────────────────────────────────────
console.log('🔁 Swapping data-new.db → data.db…');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
fs.renameSync(DB_NEW, DB_PATH);
console.log('✓ data.db updated\n');

// ─── 7. Summary ──────────────────────────────────────────────────────────────
const byStatus = records.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1;
  return acc;
}, {});

console.log('═══════════════════════════════════════');
console.log('  CET 2025 — Fresh datasource built');
console.log('═══════════════════════════════════════');
console.log(`  Total records : ${records.length.toLocaleString()}`);
console.log(`  Qualified     : ${(byStatus['Qualified'] ?? 0).toLocaleString()}`);
console.log(`  Not Qualified : ${(byStatus['Not Qualified'] ?? 0).toLocaleString()}`);
console.log(`  Absent        : ${(byStatus['Absent'] ?? 0).toLocaleString()}  ← tagged for website`);
console.log(`  Withheld      : ${(byStatus['Result Withheld'] ?? 0).toLocaleString()}`);
console.log(`  Duplicates    : ${skipped}`);
console.log('═══════════════════════════════════════\n');
