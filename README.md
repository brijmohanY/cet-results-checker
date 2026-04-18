# Haryana CET Group C — Result Portal

**Live:** https://haryana-cet-results-production.up.railway.app

---

## Why this exists

When HSSC declared the Haryana CET Group C 2025 result, they released 17 PDFs containing 13.5 lakh candidate records — raw rows of roll numbers and marks, no ranks anywhere. A friend wanted to know where he stood. So did every other candidate among the 13 lakh who appeared.

Built this to solve that: paste your roll number, get your overall rank, category rank, and marks — in under a second.

---

## What it does

- Search by roll number or registration number
- Shows overall rank, category rank, marks, category, sub-category, PWD, and status
- Marks → approximate rank table (if you don't have your roll number)
- Category-wise cut-off reference
- Key dates, vacancy details, and recruitment guidance for 2026
- Hindi + English toggle

---

## How it works

### Dataset — built once from official PDFs

Source: 17 official HSSC PDFs (*DETAIL RESULT OF CET-2025, ADVT. 01/2025*)  
Records: **13,48,836 candidates** — Qualified, Not Qualified, Absent, Result Withheld

```
pdfs/*.pdf  →  pdftotext -layout  →  parse records  →  deduplicate  →  rank  →  data.db.gz
```

```bash
# Place all 17 HSSC PDFs in pdfs/ then:
node scripts/build-from-pdf.js
```

Script does:
1. Extracts text from each PDF using `pdftotext -layout` (handles rotated pages)
2. Parses every candidate row via regex on 10-digit roll numbers (`5\d{9}`)
3. Deduplicates by roll number
4. Computes overall rank — Qualified candidates sorted marks DESC, ties share rank
5. Computes category rank within each category
6. Writes `data.db` + compresses to `data.db.gz` (47 MB, committed to git)

PDFs stay local — never committed. The compressed DB is the artefact we ship.

---

### Backend — Express + SQLite

`server.js` serves the frontend and exposes REST endpoints. On first startup it decompresses `data.db.gz` → `data.db` (~156 MB, ~10s). All queries run read-only against the SQLite DB.

Visitor/search counters are persisted in Upstash Redis (fire-and-forget, never blocks a request).

---

### Frontend — single HTML file

`public/index.html` — no build step, no framework.

- Search debounce: fires immediately on first keystroke, then 1s after last
- Falls back to external HSSC API if roll/reg not found locally
- Charts (Chart.js v4.4, CDN) lazy-load when the accordion is first opened — avoids 0×0 canvas render in hidden containers
- Service Worker: network-first for HTML (always fresh UI), cache-first for static assets

---

### Deployment — Railway

Auto-deploys from `git push origin main` via GitHub integration.

**First-time setup:**
1. Railway → New Project → Deploy from GitHub (`brijmohanY/cet-results-checker`)
2. `railway.toml` is auto-detected — no manual config needed
3. Add env vars in Railway dashboard: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`

**Ship a change:**
```bash
git add <files> && git commit -m "message" && git push origin main
# Railway deploys in ~1 minute
```

**Check health:**
```
GET /health  →  { status, uptime, records, memoryMB, upstash }
```

---

## Local development

```bash
npm install
# Needs data.db.gz present (committed to git)
node server.js
# → http://localhost:3000
```

Optional `.env` (not committed):
```
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
PORT=3000
```

---

## Key files

```
server.js                    Express server + all API routes
public/index.html            Frontend — search, charts, i18n, guidance
public/sw.js                 Service Worker
data.db.gz                   Compressed SQLite DB (committed, 47 MB)
ranks-marks.json             Static rank→marks chart data
railway.toml                 Railway build/deploy config
.railwayignore               Excludes PDFs, raw data, node_modules from Railway
scripts/build-from-pdf.js    One-time DB build from HSSC PDFs
```

---

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/search?q=` | Search by roll/reg no (min 4 chars) |
| `GET /api/stats` | Total record count |
| `GET /api/marks-rank` | Marks 40–100 → rank count |
| `GET /api/visitors` | Visitor + search totals |
| `GET /health` | Server health |
