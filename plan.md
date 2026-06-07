# Project Plan — Scrape open "דירה בהנחה" lotteries into SQLite

## Context

The user is enrolling in the government **דירה בהנחה** program (`dira.moch.gov.il`) and wants a
local, queryable dataset of every lottery **currently open for enrollment**, scraped from the live
site's `ProjectInfo` pages, to analyze and improve their odds. Required fields (by Hebrew label):

| Hebrew label | Meaning |
|---|---|
| יישוב | settlement / city |
| שכונה | neighborhood |
| דירות בפרויקט | apartments in the project |
| דירות לזכאים בפרויקט | apartments for eligible applicants |
| סה"כ נרשמים | total registrants (changes over time) |
| מתוכן דירות לחיילי מילואים לוחמים | of which: apartments for **combat** reservists |
| מתוכן דירות לחיילי מילואים פעילים | of which: apartments for **active** reservists |
| מחיר למטר | price per square meter |

**Confirmed decisions:** live dira domain only (the `data.gov.il` mirror only has *ended* lotteries —
rejected); login required (username + password, no OTP → automatable); **Playwright headless
browser**; packaged as a new NanoClaw group `groups/dira/` following the `jobs`/`nutritionist`
pattern. URL shape: `dira.moch.gov.il/{ProjectId}/{LotteryId}/ProjectInfo` (user's
"area"=ProjectId, "lottery number"=LotteryId; sample `79632/2711`). The scraper **only reads** —
it never clicks any enrollment control, and never leaves ProjectsList/ProjectInfo.

### 🔴 Domain-access approvals required before running (per the user's standing rule)
1. **The login/authentication page** — needed to obtain a session before any data is visible.
2. **ProjectsList** + **ProjectInfo** — already in approved scope. The browser stays on these; the
   SPA fetches `/api/...` internally (no direct `/api/` scraping planned, so no extra approval).

---

## Milestones

| # | Milestone | Outcome / exit criteria |
|---|-----------|--------------------------|
| **M1** | Environment & scaffold ready | ✅ `groups/dira/` exists, deps installed, gitignore in place |
| **M2** | Login + page structure mapped | ✅ No login needed — data is public. API: `GET /api/Invoker?method=Projects&param=?ProjectStatus=4&...`. Field mapping confirmed via sessionStorage inspection. |
| **M3** | Scraper + DB built | ✅ `scrape_dira.py` (no browser — plain HTTP); `record_dira.py` reads |
| **M4** | First collection run verified | ✅ 82 open lotteries scraped; 79632/2711 spot-checked; second run added 82 snapshots, lotteries stayed at 82 |
| **M5** | Documented & handed off | ✅ `CLAUDE.local.md` written |
| **(Future)** | Scheduling & analysis | Out of scope now — recurring collection + winning-rate stats |

---

## Task list

### M1 — Environment & scaffold
- [ ] Create `groups/dira/` with subdirs `skills/scrape-dira/` and `data/`.
- [ ] Add `container.json` based on `groups/jobs/container.json` (drop the Gmail MCP server; keep `skills`, `groupName`, `assistantName`).
- [ ] Create `groups/dira/secrets.local.env` template (`DIRA_USER=`, `DIRA_PASS=`); `chmod 600`. **User supplies the actual credentials.**
- [ ] Add `.gitignore` in `groups/dira/` excluding `secrets.local.env` and `data/`.
- [ ] Install deps: `pip install playwright` → `python3 -m playwright install chromium` (fallback: run inside the NanoClaw agent container, which already ships Chromium, if `install-deps` needs sudo).

### M2 — Login + page-structure discovery *(needs login-page approval + credentials)*
- [ ] Write a throwaway discovery script: launch Chromium, log in, screenshot each step.
- [ ] Capture the **login** selectors (username field, password field, submit button) and confirm a session is established.
- [ ] Open **ProjectsList**, wait for SPA render, and determine how to enumerate open lotteries' `(project_id, lottery_id)` (parse ProjectInfo links / DOM rows).
- [ ] Open the sample **ProjectInfo** `79632/2711`, screenshot, and record the exact DOM locators for all 8 Hebrew-labeled fields + extras (project name, developer, status, signup-end date).

### M3 — Scraper + DB
- [ ] Implement `scrape_dira.py`:
  - [ ] Load `DIRA_USER`/`DIRA_PASS` from env/secrets file; never log them.
  - [ ] Create schema on first run (`lotteries` + `registration_snapshots`, below).
  - [ ] Log in → enumerate open lotteries from ProjectsList.
  - [ ] For each: visit ProjectInfo, extract the 8 fields by Hebrew label + extras.
  - [ ] Upsert `lotteries` (refresh `last_seen`); insert one `registration_snapshots` row.
  - [ ] Print a JSON run summary (scraped, failed, db path).
- [ ] Implement `record_dira.py` read helpers: `list` (open lotteries + computed odds), `get --project --lottery` (one lottery + snapshot history), `stats` (best odds). Writes happen only in `scrape_dira.py`.

### M4 — First collection run & verification
- [ ] Run `scrape_dira.py` once against the live site.
- [ ] `pnpm exec tsx scripts/q.ts groups/dira/data/dira.sqlite "SELECT ... FROM lotteries LIMIT 10"` — confirm all 8 fields populated.
- [ ] Spot-check sample `79632/2711`: scraped city/apartments/registrants/price match the live page.
- [ ] Re-run once; confirm a **second** `registration_snapshots` row appears while `lotteries` stays deduplicated.
- [ ] Confirm `secrets.local.env` is gitignored and no secret is committed/printed.

### M5 — Documentation & handoff
- [ ] Write `groups/dira/CLAUDE.local.md`: identity, DB path, `scrape_dira.py`/`record_dira.py` usage, and **safety rules** (read-only; never enroll; never leave ProjectsList/ProjectInfo).
- [ ] Keep this plan (`groups/dira/plan.md`) updated as milestones complete.

---

## Database schema (`groups/dira/data/dira.sqlite`)

Two tables — slow-changing attributes vs. the time-series count, so later winning-rate trend
analysis (odds ≈ eligible apartments ÷ registrants) is possible:

```sql
CREATE TABLE IF NOT EXISTS lotteries (
  project_id              INTEGER NOT NULL,   -- "area" in the URL
  lottery_id              INTEGER NOT NULL,   -- lottery number in the URL
  city                    TEXT,               -- יישוב
  neighborhood            TEXT,               -- שכונה
  apartments_in_project   INTEGER,            -- דירות בפרויקט
  apartments_for_eligible INTEGER,            -- דירות לזכאים בפרויקט
  reserve_combat_units    INTEGER,            -- מתוכן דירות לחיילי מילואים לוחמים
  reserve_active_units    INTEGER,            -- מתוכן דירות לחיילי מילואים פעילים
  price_per_meter         REAL,               -- מחיר למטר
  project_name            TEXT,               -- extras for future analysis ↓
  developer               TEXT,
  lottery_status          TEXT,
  signup_end_date         TEXT,
  source_url              TEXT,
  first_seen              TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen               TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, lottery_id)
);

CREATE TABLE IF NOT EXISTS registration_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL,
  lottery_id    INTEGER NOT NULL,
  scraped_at    TEXT NOT NULL DEFAULT (datetime('now')),
  registrants   INTEGER,                       -- סה"כ נרשמים at this moment
  FOREIGN KEY (project_id, lottery_id) REFERENCES lotteries(project_id, lottery_id)
);
CREATE INDEX IF NOT EXISTS idx_snap_lottery ON registration_snapshots(project_id, lottery_id, scraped_at);
```

## Notes
- DB queries use the in-tree wrapper `pnpm exec tsx scripts/q.ts <db> "<sql>"` (NanoClaw has no `sqlite3` CLI).
- Credentials live only in `secrets.local.env`; never committed, printed, or sent anywhere but the dira login form.

## Out of scope (future phases)
- Scheduled/recurring collection (cron or a NanoClaw scheduled agent).
- Winning-rate statistics & recommendations.
- **Any enrollment action — never.**
