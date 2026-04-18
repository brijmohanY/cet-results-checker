import express from 'express';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import compression from 'compression';
import zlib from 'zlib';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Decompress DB if needed ────────────────────────────────────────────────
function ensureDatabase() {
  const dbPath = path.join(__dirname, 'data.db');
  const gzPath = path.join(__dirname, 'data.db.gz');

  if (!fs.existsSync(dbPath)) {
    if (!fs.existsSync(gzPath)) {
      console.error('❌ No database found. Run: node scripts/migrate.js');
      process.exit(1);
    }
    console.log('🔓 First run: decompressing data.db.gz → data.db (~10s)...');
    const start = Date.now();
    const compressed = fs.readFileSync(gzPath);
    const data = zlib.gunzipSync(compressed);
    fs.writeFileSync(dbPath, data);
    console.log(`✓ Database ready in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  }
  return dbPath;
}

const startupTime = Date.now();
const dbPath = ensureDatabase();
const db = new Database(dbPath, { readonly: true });

// ─── Persistent counters via Upstash Redis REST ──────────────────────────────
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function upstashIncr(key) {
  if (!UPSTASH_URL) return;
  fetch(`${UPSTASH_URL}/incr/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  }).catch(() => {}); // fire-and-forget, never block the response
}

async function upstashMget(...keys) {
  if (!UPSTASH_URL) return keys.map(() => 0);
  try {
    const res = await fetch(`${UPSTASH_URL}/mget/${keys.join('/')}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const body = await res.json();
    if (!body.result) throw new Error(`Upstash error: ${JSON.stringify(body)}`);
    return body.result.map(v => parseInt(v) || 0);
  } catch (e) {
    console.error('upstashMget failed:', e.message);
    return keys.map(() => 0);
  }
}

// Performance tuning
db.pragma('cache_size = -32000'); // 32MB cache
db.pragma('temp_store = MEMORY');
db.pragma('mmap_size = 268435456'); // 256MB mmap

// Prepared statements
const stmtExact   = db.prepare('SELECT * FROM results WHERE roll_no = ? OR reg_no = ? LIMIT 1');
const stmtPartial = db.prepare('SELECT * FROM results WHERE roll_no LIKE ? OR reg_no LIKE ? LIMIT 50');
// cat_rank is now stored; fall back to dynamic count for legacy DBs that lack the column
const hasCatRankCol = db.prepare("PRAGMA table_info(results)").all().some(c => c.name === 'cat_rank');
const stmtCatRank = hasCatRankCol
  ? null  // use stored cat_rank
  : db.prepare('SELECT COUNT(*) as n FROM results WHERE category = ? AND rank <= ?');
const stmtStats   = db.prepare('SELECT COUNT(*) as total FROM results');
const stmtChart   = null; // loaded from file

let ranksMarksChart = [];
const chartPath = path.join(__dirname, 'ranks-marks.json');
if (fs.existsSync(chartPath)) ranksMarksChart = JSON.parse(fs.readFileSync(chartPath, 'utf8'));

console.log(`✓ Server ready | ${stmtStats.get().total.toLocaleString()} records | ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB RAM`);

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(compression({ level: 6, threshold: 1024 }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Count page visits (only HTML requests, not assets)
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    upstashIncr('visitors');
  }
  next();
});

// ads.txt must never be cached stale — serve with no-cache
app.get('/ads.txt', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'text/plain; charset=UTF-8');
  res.sendFile(path.join(__dirname, 'public', 'ads.txt'));
});

// HTML files: no-cache so users always get the latest version
app.use(express.static('public', {
  maxAge: '1d',
  etag: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));
app.use(express.json());

// ─── API: Search ────────────────────────────────────────────────────────────
const EXTERNAL_API = 'https://hssc.sarkarisafar.in/cet/result/api.php';

app.get('/api/search', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
  res.setHeader('Vary', 'Accept-Encoding');

  const query = (req.query.q || '').toString().trim();
  if (!query || query.length < 4) {
    return res.json({ error: 'Please enter at least 4 characters', results: [] });
  }

  upstashIncr('searches');

  // O(1) exact lookup first
  const exact = stmtExact.get(query, query);
  if (exact) {
    return res.json({ results: [formatResult(exact)] });
  }

  // Partial match fallback
  const rows = stmtPartial.all(`${query}%`, `${query}%`);
  if (rows.length > 0) {
    return res.json({ results: rows.map(formatResult) });
  }

  // External API fallback
  try {
    const extRes = await fetch(`${EXTERNAL_API}?action=search&q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(5000),
    });
    const extData = await extRes.json();
    if (extData.success && extData.candidate) {
      return res.json({ results: [formatExternalResult(extData.candidate)], source: 'external' });
    }
  } catch (e) {
    // external API timed out or failed — return empty
  }

  res.json({ results: [] });
});

function formatResult(row) {
  const result = {
    'Roll No.':       row.roll_no,
    'CET Regn. No.':  row.reg_no,
    'Rank':           row.rank,
    'Marks':          row.marks,
    'Category':       row.category,
    'Sub-Cat':        row.sub_cat,
    'PWD':            row.pwd,
    'Status':         row.status,
  };

  // Add visual tag for candidates who did not appear
  if (row.status === 'Absent') {
    result['_tag'] = 'not-appeared';
  } else if (row.status === 'Result Withheld') {
    result['_tag'] = 'result-withheld';
  }

  // Category rank: use stored value if available, else compute dynamically
  if (row.rank && row.category) {
    if (hasCatRankCol && row.cat_rank != null) {
      result['Category Rank'] = row.cat_rank;
    } else if (stmtCatRank) {
      const { n } = stmtCatRank.get(row.category, row.rank);
      result['Category Rank'] = n;
    }
  }

  return result;
}

function formatExternalResult(c) {
  return {
    'Roll No.':      c.roll_number,
    'CET Regn. No.': c.regn_number,
    'Rank':          c.overall_rank,
    'Marks':         c.marks,
    'Category':      c.category,
    'Sub-Cat':       c.sub_category,
    'PWD':           c.pwd,
    'Status':        c.status,
    'Category Rank': c.category_rank,
    'Percentile':    c.percentile,
    '_source':       'external',
  };
}

// ─── API: Stats ──────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
  const { total } = stmtStats.get();
  res.json({ totalRecords: total });
});

// ─── API: Rank-Marks Chart ───────────────────────────────────────────────────
app.get('/api/rank-marks-chart', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.json(ranksMarksChart);
});

// ─── API: Marks → Rank Table (40–100 in steps of 5) ─────────────────────────
const stmtMarksRank = db.prepare(`
  SELECT COUNT(*) as rank_at_marks
  FROM results
  WHERE status = 'Qualified' AND marks >= ?
`);
app.get('/api/marks-rank', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  const rows = [];
  for (let m = 40; m <= 100; m += 5) {
    const { rank_at_marks } = stmtMarksRank.get(m);
    rows.push({ marks: m, rank: rank_at_marks });
  }
  res.json(rows);
});

// ─── API: Visitor Counter ────────────────────────────────────────────────────
app.get('/api/visitors', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const [visitors, searches] = await upstashMget('visitors', 'searches');
  res.json({ visitors, searches });
});

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Date.now() - startupTime,
    records: stmtStats.get().total,
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    upstash: !!UPSTASH_URL,
  });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ http://localhost:${PORT}  |  startup: ${Date.now() - startupTime}ms`);
});
