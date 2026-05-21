# Nexopra — Refactored Architecture

> High-signal curated intelligence. Quality > quantity.

---

## Directory Structure

```
nexopra/
├── index.js                    # WhatsApp bot entry point
│
├── collectors/
│   ├── devpost.js              # Hackathons (Priority 1)
│   ├── ycjobs.js               # YC Jobs (Priority 2)
│   ├── greenhouse_lever.js     # Greenhouse + Lever (Priority 3/4)
│   ├── wellfound.js            # Wellfound startup jobs (Priority 5)
│   ├── linkedin_indexed.js     # Google-indexed LinkedIn (Priority 6)
│   └── nitter.js               # Nitter/X curated accounts (Priority 7)
│
├── core/
│   ├── schema.js               # Normalized opportunity schema + fingerprinting
│   ├── dedup.js                # Global dedup + per-user seen tracking
│   ├── users.js                # Persistent user store
│   ├── pipeline.js             # Per-user opportunity pipeline (cache → match → deliver)
│   └── metrics.js              # Logging + source metrics
│
├── ai/
│   └── filter.js               # AI filtering (quality gate) + user matching
│
├── scheduler/
│   └── index.js                # Periodic collection scheduler
│
└── utils/
    └── playwright.js           # Shared Playwright + simpleFetch utilities
```

---

## How It Works

### 1. Collection (Background, Scheduled)

The scheduler runs collectors on a timed basis and stores results in an **in-memory cache**:

| Collection type | Interval | Sources |
|----------------|----------|---------|
| Jobs           | 30 min   | YC Jobs, Greenhouse, Lever, Wellfound, LinkedIn indexed |
| Hackathons     | 60 min   | Devpost |
| X monitoring   | 2 hours  | Nitter (curated accounts only) |

Each collector run:
1. Fetches raw opportunities from its source
2. Runs **global deduplication** (SHA1 fingerprint of title+company+URL)
3. Passes through **AI filtering** (Groq) — rejects spam, low-quality, fake listings
4. Stores accepted opportunities in the shared cache

### 2. Delivery (Per User, On-Demand or Scheduled)

When a user requests opportunities (via `now`, filter commands, or daily delivery):

1. **Pull from cache** — no live scraping at delivery time
2. **User matching** — score opportunities against user's field, skills, region, remote preference
3. **Per-user dedup** — filter out anything already sent to this user
4. **Format and send** — top 6 results maximum

---

## Normalized Opportunity Schema

```json
{
  "id": "sha1-fingerprint",
  "title": "Senior Frontend Engineer",
  "company": "Stripe",
  "type": "Job",
  "location": "San Francisco, CA",
  "remote": true,
  "source": "Greenhouse",
  "sourceUrl": "https://boards.greenhouse.io/stripe/jobs/...",
  "description": "...",
  "skills": ["React", "TypeScript", "CSS"],
  "deadline": null,
  "salary": "$140,000 – $180,000",
  "prize": null,
  "postedAt": "2025-01-15T00:00:00Z",
  "confidenceScore": 0.87
}
```

---

## Source Priority Order

1. **Devpost** — structured API, reliable hackathon data
2. **YC Jobs** — high-signal startup ecosystem
3. **Greenhouse** — public company job boards (no auth required)
4. **Lever** — public company job boards (no auth required)
5. **Wellfound** — startup hiring
6. **LinkedIn (Google indexed)** — `site:linkedin.com/jobs` queries only. No login. No scraping authenticated pages.
7. **Nitter/X** — curated tech account monitoring only. No global tweet scraping.

---

## LinkedIn: What Changed

**OLD (removed):**
- Direct LinkedIn scraping
- Login-dependent pages
- Fragile selectors

**NEW:**
- `site:linkedin.com/jobs "field" "region"` Google search queries
- `site:linkedin.com/posts "we are hiring"` for hiring announcements
- Built dynamically from user field + region + remote preference
- No authentication required. Public Google index only.

---

## X/Twitter: What Changed

**OLD:**
- Official X API dependency

**NEW (Nitter):**
- Nitter instances (nitter.net + fallbacks)
- Curated accounts list only — not global scraping
- Opportunity signal detection (hiring/hackathon/grant keywords)
- Multiple instance fallback if one is down

---

## AI Filtering

Every batch of collected opportunities is classified by Groq before entering the cache:

- **real/fake** — rejects spam, duplicate-sounding, vague listings
- **type** — corrects mislabeled opportunity types
- **skills** — extracts required skills from description
- **experienceLevel** — entry / mid / senior / any
- **studentFriendly** — boolean
- **urgency** — high / medium / low
- **confidenceScore** — 0.0 to 1.0 (threshold: 0.45 to pass)

---

## Deduplication

Two layers:
1. **Global** (`dedup_store.json`) — prevents the same opportunity from entering the cache twice across runs
2. **Per-user** (`seen_opportunities.json`) — prevents resending the same opportunity to the same WhatsApp user

Fingerprint: `SHA1(normalized_title || company || sourceUrl)`

---

## Metrics Tracked

```json
{
  "totalFound": 1240,
  "duplicatesRemoved": 380,
  "aiAccepted": 620,
  "aiRejected": 240,
  "failedScrapes": 12,
  "bySource": {
    "Devpost": { "found": 45, "failed": 1 },
    "YC Jobs": { "found": 30, "failed": 0 }
  }
}
```

---

## Installation

```bash
npm install
npx playwright install chromium
cp .env.example .env
# Add GROQ_API_KEY to .env
node index.js
```

---

## Adding New Sources

1. Create `collectors/mysource.js`
2. Export `async function collectMySource(field)` returning `NormalizedOpportunity[]`
3. Use `normalizeOpportunity()` from `core/schema.js`
4. Call `recordFound()` / `recordFailed()` from `core/metrics.js`
5. Add to the appropriate scheduler run in `scheduler/index.js`

---

## Design Principle

> Nexopra is NOT a scraper. It is a **high-signal intelligence layer**.
>
> Users receive fewer opportunities — but every one is relevant, verified, and deduplicated.