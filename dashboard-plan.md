# Plan — `pinidira.duckdns.org` lottery-odds analysis dashboard

## Context

The dira scraper (`groups/dira/`) now collects 82 open "דירה בהנחה" lotteries into
`data/dira.sqlite` (read-only, per the project's hard rule — never enroll, never submit).
Pini wants to **act on** that data: a website at `pinidira.duckdns.org` that shows his
real winning chances per lottery, factoring in his **active-reservist priority**, lets him
**filter and partition by city**, and surfaces **which locations are the best value**
(biggest discount) at acceptable odds — so he can pick where to register.

### What the data supports (verified read-only against the live DB)
- Every lottery carves sub-quotas out of `apartments_for_eligible`:
  `handicapped` + `reserve_combat` (~25%) + `reserve_active` (~25%) + `local` → remainder = **open pool**.
  Example: 303 eligible = 10 handicapped + 75 combat + 76 active-reservist + 60 local + **82 open**.
- **Pini's profile**: active (non-combat) reservist, 300+ reserve days since 7.10.2023 (≫ the 60-day
  qualifying threshold → qualification certain), grade ה. He draws first from the **`reserve_active_units`
  ~25% pool**, then cascades to the **open pool** if he doesn't win. He is *not* in the combat 25% pool.
- **Key limitation**: `registrants_reserve_duty` / `registrants_combat` are **always 0** while a lottery
  is open — the IDF only reveals reservist eligibility *after* the lottery closes. So reservist-pool odds
  must be **modeled with an assumption** (interactive slider), not measured. `registrants` (total) and
  `registrants_local` *are* known; `participants_count` is present for 49/82, else fall back to `registrants`.
- `grant_size` is empty → the only price signal in the data is `price_per_meter`. Discount % therefore
  needs a **researched market ₪/m² per city** (I look these up; Pini enters nothing).
- 19 cities; heavy multi-lottery cities (מעלה אדומים ×16, כפר סבא ×11, קריית גת ×9) → city partitioning matters.

### Decisions (confirmed with Pini)
- **Static, filterable dashboard, partitioned by city** — no chat agent, no NanoClaw `src/` changes.
- **Discount %** computed against **market ₪/m² per city that I research** (Madlan / Madadirot / CBS),
  baked into the site with each value sourced + dated. Pini does not enter prices. (Editable later as an override.)
- **Reservist odds** driven by an **interactive slider** (assumed share of registrants who are qualifying
  active reservists), recomputing live with optimistic/likely/pessimistic framing.

---

## Milestones

| # | Milestone | Outcome / exit criteria |
|---|-----------|--------------------------|
| **M1** | Market-price research | `webapp/market_prices.json` holds a market ₪/m² for **all 19 cities**, each with `source` URL + `as_of` month. Spot-checked against Madlan/Madadirot. |
| **M2** | Data exporter | `build_site_data.py` (read-only) writes `webapp/data.json` — one object per lottery with quotas, `a_open`, latest registrants/participants, price, deadline, flags + `generated_at` + city list. Spot-check 79632/2711 matches DB. |
| **M3** | Dashboard frontend | `index.html` + `app.js` + `style.css`: 3 tabs (Lotteries / By city / Sweet spot), city-partition filters, live reservist slider, discount %, SVG scatter. Renders all 82 lotteries. |
| **M4** | Local verification | Filters narrow rows; slider moves odds live; city-aggregate odds > any single lottery; discount % shows (~50% for כפר סבא); hand-checked odds math passes. |
| **M5** | Hosting & handoff | DuckDNS `pinidira` registered; Caddy `file_server` block added + reloaded; TLS live; `CLAUDE.local.md`, `plan.md`, memory updated. `https://pinidira.duckdns.org` loads. |

---

## Architecture

Pure static site. No backend, no build step, no changes to `/home/pini/nanoclaw/src/`.

```
scrape_dira.py ──writes──▶ data/dira.sqlite ──read──▶ build_site_data.py ──writes──▶ webapp/data.json
                                                                                          │
Caddy  pinidira.duckdns.org { root webapp; file_server }  ──serves──▶  index.html + app.js (all odds in-browser)
```

All odds/discount math runs **client-side in `app.js`** from `data.json`. Refresh = re-run scraper then exporter.

---

## Odds engine (client-side, documented in `app.js`)

Per lottery, from the latest snapshot:
- `A` = `apartments_for_eligible`; sub-quotas `a_h` (handicapped), `a_c` (combat), `a_r` (active-reservist), `a_l` (local).
- `a_open = A − (a_h + a_c + a_r + a_l)` (clamped ≥ 0).
- `N` = `participants_count ?? registrants` (denominator).
- Slider input `p` = assumed fraction of `N` who are qualifying **active** reservists like Pini (default ~0.15; range 0.05–0.40).

National cascade order: handicapped → combat → **active reservist (Pini's stage)** → local → open;
non-winners fall through to the next stage they're eligible for.

- **Stage 1 — active-reservist pool**: competitors ≈ `R = max(p·N, a_r)`.
  `P1 = min(1, a_r / R)`.
- **Stage 2 — open pool** (only if he lost stage 1): everyone who hasn't won yet competes for `a_open`.
  competitors ≈ `N − (a_h + a_c + a_r + a_l)` (clamped ≥ `a_open`).
  `P2 = min(1, a_open / competitors)`.
- **Pini's combined odds**: `P = P1 + (1 − P1)·P2`.
- Also show a **baseline "no-priority" odds** `A / N` for contrast, and the three slider scenarios.

City **aggregate** ("chance to win *somewhere* in the city if you register to all its lotteries"):
`1 − Π(1 − P_i)` across that city's lotteries — meaningful because you may register to several.

The UI states plainly these are **estimates** (reservist counts hidden until close); grade ה and
300+ days are an upside not separately modeled (only raise his within-pool standing).

---

## Discount / value

- **I research a market ₪/m² for each of the 19 cities** (sources: Madlan area-info pages, Madadirot,
  CBS/Lamas) and bake them into `webapp/market_prices.json` as
  `{ "<city>": { "market_per_meter": <num>, "source": "<url>", "as_of": "<YYYY-MM>" }, ... }`.
  Feasibility verified (e.g. כפר סבא ≈ ₪31–34k/m² market vs ₪15–18k/m² dira → ~50% discount).
- `discount_pct = (market − price_per_meter) / market`, shown per lottery and aggregated per city.
- The market figures are visible/overridable in a small Settings panel (override persisted to
  `localStorage`), but the **default values are the ones I research** — Pini enters nothing.
- A header note flags that market prices are approximate and dated; the scatter/value axis uses
  discount % (falls back to raw ₪/m² only if a city's market price is somehow missing).

---

## UI / features (`index.html` + `app.js` + `style.css`)

Single page, mobile-friendly, three views via top tabs:

1. **Lotteries** (default) — sortable, filterable table. Columns: city, neighborhood, eligible apts,
   active-reservist apts, **Pini odds %**, baseline odds %, ₪/m², discount %, registrants, signup deadline,
   religious flag. **Filters**: city (multi-select / "partition by city"), ₪/m² range, min apartments,
   max days-to-deadline, religious yes/no, reservist-quota present. Global **reservist-share slider**
   recomputes all odds live.
2. **By city** — one card/row per city (the primary partition): #lotteries, total eligible + active-reservist
   apts, ₪/m² min–max, avg discount %, **best single-lottery Pini odds**, and **aggregate city odds**.
   Sortable by odds or by value. Click → filters the Lotteries table to that city.
3. **Sweet spot** — scatter chart: x = Pini odds %, y = discount % (or ₪/m² if no market data),
   bubble size = eligible apts, colour = city. Top-right = high odds + high discount. Hover → details.
   (Hand-rolled inline SVG scatter — no external chart dependency, fully offline/self-contained.)

Plus a small **Settings/market-prices** panel (shows the researched market ₪/m² per city, with the
source link + date; values can be overridden locally) and a header note showing the `data.json`
generation timestamp and the market-price `as_of` date.

---

## Files

**New**
- `groups/dira/webapp/index.html` — shell + tabs (model the head/meta/PWA conventions from
  `groups/jobs/webapp/index.html`).
- `groups/dira/webapp/app.js` — data load, odds engine, filters, city aggregation, SVG scatter,
  market-price overrides (localStorage).
- `groups/dira/webapp/style.css` — adapt jobs styling (dark theme, mobile nav).
- `groups/dira/webapp/market_prices.json` — **researched** market ₪/m² for all 19 cities, each with
  `source` URL + `as_of` month (M1).
- `groups/dira/webapp/data.json` — generated (gitignored alongside `data/`).
- `groups/dira/skills/scrape-dira/build_site_data.py` — **read-only** exporter: opens
  `dira.sqlite` with `mode=ro`, joins latest snapshot per lottery, computes `a_open`, emits one JSON
  object per lottery (ids, city, neighborhood, all quota fields, price_per_meter, registrants,
  participants_count, signup_end_date, is_religious, source_url) + `generated_at` + distinct city list.
  Reuses the latest-snapshot pattern already in `record_dira.py:_latest_snap_query()`.

**Modify**
- `/home/pini/nanoclaw/Caddyfile` — add a static site block:
  ```
  pinidira.duckdns.org {
      root * /home/pini/nanoclaw/groups/dira/webapp
      file_server
  }
  ```
  (verify against the *running* Caddy config, which has the real filled-in domains, not the repo template).
- `groups/dira/.gitignore` — add `webapp/data.json`.
- `groups/dira/CLAUDE.local.md` — document the dashboard, the exporter, and the refresh command.
- `groups/dira/plan.md` — note the analysis/dashboard phase is now in scope and how to rebuild.
- `~/.claude/projects/-home-pini/memory/project_dira_scraper.md` + `MEMORY.md` — record the
  `pinidira.duckdns.org` dashboard, the static/Caddy approach, and the reservist-odds model.

**Untouched**: NanoClaw `src/`, the node host, `scrape_dira.py`, `record_dira.py` (the scraper/readers
stay exactly as they are — the exporter is additive and read-only).

---

## Market-price research (M1 — mine to do)
Look up a representative market ₪/m² for each of the 19 cities — מעלה אדומים, כפר סבא, קריית גת,
קדימה-צורן, רכסים, בית דגן, מזכרת בתיה, חדרה, בני עי"ש, בית שמש, בת חפר, ראשון לציון, נהרייה, כפר מנדא,
רחובות, יקנעם עילית, יהוד, אשדוד, אילת — primarily from Madlan area-info and Madadirot, recording each
value's source URL and month into `market_prices.json`. Refreshable later by re-running the same
research; the UI shows the `as_of` date so staleness is visible.

## Hosting / ops (M5 — one-time)
1. Register `pinidira` on DuckDNS → point at the server IP (Pini's DuckDNS account — flag if not done).
2. Add the Caddy block above to the live config and reload Caddy.
3. TLS auto-provisions via Let's Encrypt (Caddy), same as the jobs/nutrition sites.

(Recurring auto-refresh via cron is **out of scope** unless requested; manual re-run is the refresh path.)

---

## Verification (end-to-end)
1. `python3 groups/dira/skills/scrape-dira/build_site_data.py` → `webapp/data.json` written; spot-check
   one known lottery (e.g. 79632/2711) — quota fields + `a_open` + registrants match the DB.
2. Serve locally (`python3 -m http.server` in `webapp/`) and confirm: table renders all 82 lotteries;
   city filter narrows rows; the reservist slider visibly moves Pini-odds; the "By city" aggregate odds
   for מעלה אדומים (16 lotteries) is higher than any single lottery there; the scatter plots and hovers.
3. Confirm researched market ₪/m² loads for every city and discount % is computed (e.g. כפר סבא dira
   ~₪16k vs market ~₪32k → ~50%); a local override edits + persists across reload (localStorage).
4. Sanity-check odds math by hand for one lottery (e.g. 303 eligible, `a_r`=76, `a_open`=82, N≈12,193,
   slider 0.15): `P1 = 76/1829 ≈ 4.2%`, `P2 = 82/12042 ≈ 0.68%`, combined ≈ **4.8%** vs baseline `303/12193 ≈ 2.5%`.
5. After Caddy + DuckDNS: load `https://pinidira.duckdns.org`, confirm TLS + the site loads.

## Caveats called out in the UI
- Reservist-pool odds are **modelled estimates** (real reservist registrant counts are hidden until the
  lottery closes); the slider is the assumption knob.
- Grade ה / 300+ days guarantee qualification and raise his within-pool standing — an upside beyond the
  random-draw model, not separately quantified.
- Discount % is vs **researched, approximate, dated** market ₪/m² per city (city-average, not
  project-specific); the `as_of` date is shown so Pini can judge staleness.
