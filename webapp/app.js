// Dira b'Hanacha analysis dashboard
// All odds math is client-side; no backend.

const DATA_URL   = 'data.json';
const PRICES_URL = 'market_prices.json';
const LS_KEY     = 'dira_market_overrides';

// ── State ──────────────────────────────────────────────────────────────────────
let allLotteries = [];
let marketBase   = {};   // from market_prices.json
let marketPrices = {};   // merged with localStorage overrides
let sliderP      = 0.15; // assumed fraction of registrants who are active reservists
let sortKey      = 'pini_odds';
let citySortKey  = 'agg_odds';
let filterCities = new Set();
let filterReservist = false;
let filterNoReligious = false;
let filterMaxDays = null;

// ── Odds engine ────────────────────────────────────────────────────────────────
function computeOdds(lot, p) {
  const A  = lot.apartments_for_eligible || 0;
  const ah = lot.handicapped_units || 0;
  const ac = lot.reserve_combat_units || 0;
  const ar = lot.reserve_active_units || 0;
  const al = lot.local_housing_units || 0;
  const ao = lot.a_open || 0;  // pre-computed in build_site_data.py
  const N  = lot.participants_count ?? lot.registrants ?? 0;

  if (N <= 0 || A <= 0) return { pini: null, baseline: null };

  const baseline = A / N;

  // Stage 3: non-combat active-reservist pool (Pini's primary stage)
  // Combat winners (ac) already exited in Stage 2 — subtract them from the reservist pool
  const R = Math.max(ar, p * N - ac);
  const P1 = ar > 0 ? Math.min(1, ar / R) : 0;

  // Stage 2: open pool (if lost stage 1)
  // Local registrants who didn't win the local quota re-enter the open pool.
  // Only the al quota winners exit; subtract them (along with other quota winners) from N.
  const openCompetitors = Math.max(ao, N - (ah + ac + ar + al));
  const P2 = ao > 0 ? Math.min(1, ao / openCompetitors) : 0;

  const pini = P1 + (1 - P1) * P2;
  return { pini: Math.min(1, pini), baseline: Math.min(1, baseline) };
}

function cityAggregate(lots, p) {
  const odds = lots.map(l => computeOdds(l, p).pini).filter(v => v !== null);
  if (!odds.length) return null;
  return 1 - odds.reduce((acc, o) => acc * (1 - o), 1);
}

function daysToClose(lot) {
  if (!lot.signup_end_date) return null;
  const ms = new Date(lot.signup_end_date) - Date.now();
  return Math.ceil(ms / 86400000);
}

function discountPct(lot) {
  const m = marketPrices[lot.city]?.market_per_meter;
  if (!m || !lot.price_per_meter) return null;
  return (m - lot.price_per_meter) / m;
}

// ── Formatting helpers ─────────────────────────────────────────────────────────
const fmt = {
  pct:    v => v == null ? '—'  : (v * 100).toFixed(1) + '%',
  price:  v => v == null ? '—'  : '₪' + Math.round(v).toLocaleString(),
  num:    v => v == null ? '—'  : v.toLocaleString(),
};

function oddsClass(v) {
  if (v == null) return '';
  if (v >= 0.04) return 'odds-high';
  if (v >= 0.015) return 'odds-mid';
  return 'odds-low';
}
function discountClass(v) {
  if (v == null) return '';
  if (v >= 0.35) return 'discount-high';
  if (v >= 0.2)  return 'discount-mid';
  return 'discount-low';
}
function daysClass(d) {
  if (d == null) return '';
  if (d <= 7)  return 'days-urgent';
  if (d <= 14) return 'days-soon';
  return '';
}

// ── Filter + sort lotteries ────────────────────────────────────────────────────
function filteredLotteries() {
  return allLotteries.filter(l => {
    if (filterCities.size > 0 && !filterCities.has(l.city)) return false;
    if (filterReservist && !(l.reserve_active_units > 0)) return false;
    if (filterNoReligious && l.is_religious) return false;
    if (filterMaxDays != null) {
      const d = daysToClose(l);
      if (d == null || d > filterMaxDays) return false;
    }
    return true;
  });
}

function sortedLotteries(lots) {
  return [...lots].sort((a, b) => {
    const oa = computeOdds(a, sliderP), ob = computeOdds(b, sliderP);
    const da = discountPct(a), db = discountPct(b);
    switch (sortKey) {
      case 'pini_odds':     return (ob.pini ?? -1) - (oa.pini ?? -1);
      case 'baseline_odds': return (ob.baseline ?? -1) - (oa.baseline ?? -1);
      case 'discount':      return (db ?? -1) - (da ?? -1);
      case 'price':         return (a.price_per_meter ?? 9e9) - (b.price_per_meter ?? 9e9);
      case 'city':          return (a.city || '').localeCompare(b.city || '');
      default: return 0;
    }
  });
}

// ── Render: lottery table ──────────────────────────────────────────────────────
function renderLotteries() {
  const lots = sortedLotteries(filteredLotteries());
  const tbody = document.getElementById('lottery-tbody');
  const empty = document.getElementById('lottery-empty');
  if (!lots.length) { tbody.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';

  tbody.innerHTML = lots.map(l => {
    const { pini, baseline } = computeOdds(l, sliderP);
    const disc = discountPct(l);
    const days = daysToClose(l);
    const N    = l.participants_count ?? l.registrants;
    return `<tr data-pid="${l.project_id}" data-lid="${l.lottery_id}">
      <td>
        <div class="td-city">${l.city}${l.is_religious ? ' <span class="tag-religious">קהילתי</span>' : ''}</div>
        <div class="td-hood">${l.neighborhood || ''}</div>
      </td>
      <td>${l.apartments_for_eligible ?? '—'}</td>
      <td>${l.reserve_active_units ?? '—'}</td>
      <td class="${oddsClass(pini)}">${fmt.pct(pini)}</td>
      <td class="${oddsClass(baseline)}">${fmt.pct(baseline)}</td>
      <td>${fmt.price(l.price_per_meter)}</td>
      <td class="${discountClass(disc)}">${fmt.pct(disc)}</td>
      <td>${fmt.num(N)}</td>
      <td class="${daysClass(days)}">${days ?? '—'}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => openRowPanel(
      parseInt(tr.dataset.pid), parseInt(tr.dataset.lid)
    ));
  });
  updateSummaryStats();
}

function updateSummaryStats() {
  const lots = filteredLotteries();
  const count = lots.length;
  
  const oddsList = lots.map(l => computeOdds(l, sliderP).pini).filter(v => v !== null);
  const bestOdds = oddsList.length ? Math.max(...oddsList) : 0;
  
  const discounts = lots.map(l => discountPct(l)).filter(v => v !== null);
  const avgDiscount = discounts.length ? (discounts.reduce((a, b) => a + b, 0) / discounts.length) : 0;
  
  const reservistApts = lots.reduce((acc, l) => acc + (l.reserve_active_units || 0), 0);
  
  const elTotal = document.getElementById('stat-total-lotteries');
  const elBest = document.getElementById('stat-best-odds');
  const elDiscount = document.getElementById('stat-avg-discount');
  const elApts = document.getElementById('stat-reservist-apts');
  
  if (elTotal) elTotal.textContent = fmt.num(count);
  if (elBest) elBest.textContent = fmt.pct(bestOdds);
  if (elDiscount) elDiscount.textContent = fmt.pct(avgDiscount);
  if (elApts) elApts.textContent = fmt.num(reservistApts);
}

// ── Render: city tab ───────────────────────────────────────────────────────────
function cityStats() {
  const byCityMap = {};
  for (const l of allLotteries) {
    if (!byCityMap[l.city]) byCityMap[l.city] = [];
    byCityMap[l.city].push(l);
  }
  return Object.entries(byCityMap).map(([city, lots]) => {
    const prices = lots.map(l => l.price_per_meter).filter(Boolean);
    const discs  = lots.map(l => discountPct(l)).filter(v => v != null);
    const piniOdds = lots.map(l => computeOdds(l, sliderP).pini).filter(v => v != null);
    return {
      city, lots,
      count:     lots.length,
      totalApts: lots.reduce((s, l) => s + (l.apartments_for_eligible || 0), 0),
      totalActive: lots.reduce((s, l) => s + (l.reserve_active_units || 0), 0),
      minPrice:  prices.length ? Math.min(...prices) : null,
      maxPrice:  prices.length ? Math.max(...prices) : null,
      avgDiscount: discs.length ? discs.reduce((s, v) => s + v, 0) / discs.length : null,
      bestOdds:  piniOdds.length ? Math.max(...piniOdds) : null,
      aggOdds:   cityAggregate(lots, sliderP),
    };
  });
}

function renderCities() {
  const stats = cityStats().sort((a, b) => {
    switch (citySortKey) {
      case 'agg_odds':  return (b.aggOdds ?? -1) - (a.aggOdds ?? -1);
      case 'best_odds': return (b.bestOdds ?? -1) - (a.bestOdds ?? -1);
      case 'discount':  return (b.avgDiscount ?? -1) - (a.avgDiscount ?? -1);
      case 'price':     return (a.minPrice ?? 9e9) - (b.minPrice ?? 9e9);
      default: return 0;
    }
  });

  const wrap = document.getElementById('city-cards');
  wrap.innerHTML = stats.map(s => `
    <div class="city-card" data-city="${s.city}">
      <div class="city-card-header">
        <span class="city-name">${s.city}</span>
        <span class="city-agg-odds ${oddsClass(s.aggOdds)}">${fmt.pct(s.aggOdds)}</span>
      </div>
      <div class="city-row">
        <span class="city-stat"><strong>${s.count}</strong> הגרלות</span>
        <span class="city-stat"><strong>${s.totalApts}</strong> דירות זכאים</span>
        <span class="city-stat"><strong>${s.totalActive}</strong> מילואים</span>
        <span class="city-stat">₪${Math.round(s.minPrice ?? 0).toLocaleString()}–${Math.round(s.maxPrice ?? 0).toLocaleString()}/מ׳</span>
        <span class="city-stat ${discountClass(s.avgDiscount)}">הנחה ${fmt.pct(s.avgDiscount)}</span>
        <span class="city-stat">סיכוי מיטבי <strong class="${oddsClass(s.bestOdds)}">${fmt.pct(s.bestOdds)}</strong></span>
      </div>
    </div>
  `).join('');

  wrap.querySelectorAll('.city-card').forEach(card => {
    card.addEventListener('click', () => {
      filterCities.clear();
      filterCities.add(card.dataset.city);
      document.querySelectorAll('.city-chip').forEach(b => {
        b.classList.toggle('active', filterCities.has(b.dataset.city));
      });
      switchTab('lotteries');
      renderLotteries();
    });
  });
}

// ── Render: scatter ────────────────────────────────────────────────────────────
const CITY_COLORS = [
  '#3b82f6','#22c55e','#eab308','#ef4444','#8b5cf6',
  '#06b6d4','#f97316','#ec4899','#14b8a6','#a855f7',
  '#84cc16','#f43f5e','#0ea5e9','#fb923c','#4ade80',
  '#e879f9','#fbbf24','#34d399','#60a5fa',
];
const colorFor = (() => {
  const map = {};
  return city => {
    if (!map[city]) {
      const idx = Object.keys(map).length % CITY_COLORS.length;
      map[city] = CITY_COLORS[idx];
    }
    return map[city];
  };
})();

function renderScatter() {
  const svg = document.getElementById('scatter-svg');
  const wrap = document.getElementById('scatter-wrap');
  const tooltip = document.getElementById('scatter-tooltip');
  const W = wrap.clientWidth || 340;
  const H = Math.min(W * 0.75, 320);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);

  const PAD = { top: 16, right: 16, bottom: 36, left: 44 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top  - PAD.bottom;

  const lots = allLotteries.map(l => ({
    l,
    x: computeOdds(l, sliderP).pini,
    y: discountPct(l),
    r: Math.sqrt(l.apartments_for_eligible || 1),
  })).filter(d => d.x != null && d.y != null);

  if (!lots.length) { svg.innerHTML = '<text x="50%" y="50%" fill="#64748b" text-anchor="middle">אין נתונים</text>'; return; }

  const maxX = Math.max(...lots.map(d => d.x), 0.06);
  const maxY = Math.max(...lots.map(d => d.y), 0.5);
  const minY = Math.min(...lots.map(d => d.y), 0);
  const maxR = Math.max(...lots.map(d => d.r));
  const scaleX = v => PAD.left + (v / maxX) * plotW;
  const scaleY = v => PAD.top  + plotH - ((v - minY) / (maxY - minY)) * plotH;
  const scaleR = v => 4 + (v / maxR) * 14;

  // Grid lines
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const yv = minY + (i / 4) * (maxY - minY);
    const yp = scaleY(yv);
    grid += `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${yp}" y2="${yp}" stroke="#334155" stroke-width="1"/>`;
    grid += `<text x="${PAD.left - 4}" y="${yp + 4}" fill="#64748b" font-size="9" text-anchor="end">${(yv * 100).toFixed(0)}%</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const xv = (i / 4) * maxX;
    const xp = scaleX(xv);
    grid += `<line x1="${xp}" x2="${xp}" y1="${PAD.top}" y2="${H - PAD.bottom}" stroke="#334155" stroke-width="1"/>`;
    grid += `<text x="${xp}" y="${H - PAD.bottom + 12}" fill="#64748b" font-size="9" text-anchor="middle">${(xv * 100).toFixed(1)}%</text>`;
  }

  // Axis labels
  grid += `<text x="${PAD.left + plotW / 2}" y="${H - 2}" fill="#64748b" font-size="9" text-anchor="middle">סיכוי שלי →</text>`;
  grid += `<text x="10" y="${PAD.top + plotH / 2}" fill="#64748b" font-size="9" text-anchor="middle" transform="rotate(-90,10,${PAD.top + plotH / 2})">הנחה →</text>`;

  // Bubbles
  const bubbles = lots.map((d, i) => {
    const cx = scaleX(d.x), cy = scaleY(d.y), r = scaleR(d.r);
    const col = colorFor(d.l.city);
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${col}" fill-opacity="0.75" stroke="${col}" stroke-width="1" data-idx="${i}" class="bubble"/>`;
  }).join('');

  svg.innerHTML = grid + bubbles;

  // Tooltip on hover
  svg.querySelectorAll('.bubble').forEach(el => {
    el.addEventListener('mouseenter', e => {
      const d = lots[+el.dataset.idx];
      tooltip.innerHTML = `<strong>${d.l.city}</strong><br>${d.l.neighborhood || ''}<br>סיכוי: ${fmt.pct(d.x)}<br>הנחה: ${fmt.pct(d.y)}<br>דירות: ${d.l.apartments_for_eligible}`;
      tooltip.style.display = 'block';
      positionTooltip(e, tooltip, wrap);
    });
    el.addEventListener('mousemove', e => positionTooltip(e, tooltip, wrap));
    el.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  });
}

function positionTooltip(e, tip, wrap) {
  const rect = wrap.getBoundingClientRect();
  let left = e.clientX - rect.left + 12;
  let top  = e.clientY - rect.top  - 40;
  if (left + 200 > rect.width) left = e.clientX - rect.left - 210;
  if (top < 0) top = 4;
  tip.style.left = left + 'px';
  tip.style.top  = top  + 'px';
}

// ── Row detail panel ───────────────────────────────────────────────────────────
function openRowPanel(pid, lid) {
  const l = allLotteries.find(x => x.project_id === pid && x.lottery_id === lid);
  if (!l) return;
  const { pini, baseline } = computeOdds(l, sliderP);
  const disc  = discountPct(l);
  const days  = daysToClose(l);
  const N     = l.participants_count ?? l.registrants;
  const mkt   = marketPrices[l.city]?.market_per_meter;

  document.getElementById('row-title').textContent    = `${l.city} — ${l.neighborhood || ''}`;
  document.getElementById('row-subtitle').textContent = l.batch_name || l.process_name || '';

  const field = (label, val) => `<div class="row-field"><span class="row-field-label">${label}</span><span class="row-field-val">${val}</span></div>`;

  document.getElementById('row-body').innerHTML = `
    <div class="big-odds ${oddsClass(pini)}">${fmt.pct(pini)}</div>
    <div class="big-odds-label">סיכוי שלך (עם עדיפות מילואים)</div>

    <div class="row-section">
      <div class="row-section-label">סיכויים</div>
      ${field('סיכוי בסיס', fmt.pct(baseline))}
      ${field('סיכוי מצטבר בעיר', fmt.pct(cityAggregate(allLotteries.filter(x => x.city === l.city), sliderP)))}
    </div>

    <div class="row-section">
      <div class="row-section-label">דירות</div>
      ${field('זכאים', l.apartments_for_eligible)}
      ${field('מילואים פעילים', l.reserve_active_units)}
      ${field('מילואים לוחמים', l.reserve_combat_units)}
      ${field('מקומיים', l.local_housing_units)}
      ${field('נכים', l.handicapped_units)}
      ${field('בריכה פתוחה', l.a_open)}
    </div>

    <div class="row-section">
      <div class="row-section-label">מחיר וערך</div>
      ${field('מחיר/מ׳ (הגרלה)', fmt.price(l.price_per_meter))}
      ${field('מחיר/מ׳ (שוק)', mkt ? fmt.price(mkt) : '—')}
      ${field('הנחה משוק', fmt.pct(disc))}
    </div>

    <div class="row-section">
      <div class="row-section-label">רישום</div>
      ${field('רשומים סה״כ', fmt.num(l.registrants))}
      ${field('משתתפים מאומתים', fmt.num(l.participants_count))}
      ${field('מקומיים רשומים', fmt.num(l.registrants_local))}
      ${field('ימים לסגירה', days ?? '—')}
      ${field('תאריך סיום', l.signup_end_date ? l.signup_end_date.slice(0,10) : '—')}
    </div>

    <div class="row-section">
      <div class="row-section-label">פרטים</div>
      ${field('יזם', l.developer || '—')}
      ${field('מכרז', l.tender_name || '—')}
      ${l.is_religious ? field('סוג', 'קהילה דתית') : ''}
      <div class="row-field"><span class="row-field-label">קישור</span><a class="row-field-val" href="${l.source_url}" target="_blank">פרטי פרויקט ↗</a></div>
    </div>

    <p style="font-size:11px;color:var(--muted);margin-top:8px">
      ⚠️ סיכויי מילואים הם הערכה — מספר מתחרי המילואים נחשף רק לאחר סגירת הגרלה.<br>
      מחיר שוק הוא ממוצע עירוני לדירת 4 חדרים (madadirot.co.il, יוני 2026).
    </p>
  `;

  document.getElementById('row-overlay').classList.add('show');
  document.getElementById('row-panel').classList.add('open');
}

// ── Settings panel ─────────────────────────────────────────────────────────────
function renderMarketPriceList() {
  const wrap = document.getElementById('market-price-list');
  const cities = [...new Set(allLotteries.map(l => l.city).filter(Boolean))].sort();
  wrap.innerHTML = cities.map(city => {
    const base  = marketBase[city]?.market_per_meter;
    const cur   = marketPrices[city]?.market_per_meter;
    const diraP = allLotteries.filter(l => l.city === city).map(l => l.price_per_meter).filter(Boolean);
    const avgDira = diraP.length ? diraP.reduce((s, v) => s + v, 0) / diraP.length : null;
    const disc = cur && avgDira ? ((cur - avgDira) / cur * 100).toFixed(0) + '%' : '—';
    return `<div class="market-row">
      <span class="market-city">${city}</span>
      <input class="market-input" data-city="${city}" type="number" min="1000" max="100000" value="${cur || ''}" placeholder="${base || ''}">
      <span class="market-discount" data-city-disc="${city}">${disc}</span>
    </div>`;
  }).join('');

  wrap.querySelectorAll('.market-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const city = inp.dataset.city;
      const val  = parseFloat(inp.value);
      if (val > 0) {
        marketPrices[city] = { ...marketBase[city], market_per_meter: val };
      } else {
        marketPrices[city] = { ...marketBase[city] };
        inp.value = marketBase[city]?.market_per_meter || '';
      }
      saveOverrides();
      renderAll();
    });
  });
}

function saveOverrides() {
  const overrides = {};
  for (const [city, data] of Object.entries(marketPrices)) {
    if (data.market_per_meter !== marketBase[city]?.market_per_meter) {
      overrides[city] = data.market_per_meter;
    }
  }
  localStorage.setItem(LS_KEY, JSON.stringify(overrides));
}

function loadOverrides() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const overrides = JSON.parse(raw);
    for (const [city, val] of Object.entries(overrides)) {
      if (marketPrices[city]) marketPrices[city] = { ...marketPrices[city], market_per_meter: val };
    }
  } catch {}
}

// ── Tab switching ──────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name)?.classList.add('active');
  document.querySelector(`.nav-tab[data-tab="${name}"]`)?.classList.add('active');
  
  const mainEl = document.getElementById('main');
  if (mainEl) mainEl.scrollTop = 0;

  if (name === 'cities')  renderCities();
  if (name === 'scatter') renderScatter();
}

// ── Render all ─────────────────────────────────────────────────────────────────
function renderAll() {
  renderLotteries();
  const activeTab = document.querySelector('.tab-pane.active')?.id.replace('tab-', '');
  if (activeTab === 'cities')  renderCities();
  if (activeTab === 'scatter') renderScatter();
}

// ── City chips ─────────────────────────────────────────────────────────────────
function populateCityFilter(cities) {
  const wrap = document.getElementById('city-chips');
  wrap.innerHTML = cities.map(c =>
    `<button class="city-chip" data-city="${c}">${c}</button>`
  ).join('');
  wrap.querySelectorAll('.city-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const city = btn.dataset.city;
      if (filterCities.has(city)) {
        filterCities.delete(city);
        btn.classList.remove('active');
      } else {
        filterCities.add(city);
        btn.classList.add('active');
      }
      renderLotteries();
    });
  });
}

// ── Toast ──────────────────────────────────────────────────────────────────────
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const [dataRes, pricesRes] = await Promise.all([
      fetch(DATA_URL),
      fetch(PRICES_URL),
    ]);
    const data   = await dataRes.json();
    marketBase   = await pricesRes.json();
    marketPrices = JSON.parse(JSON.stringify(marketBase)); // deep copy
    loadOverrides();

    allLotteries = data.lotteries;
    const ts = data.generated_at ? new Date(data.generated_at).toLocaleString('he-IL') : '—';
    document.getElementById('sync-bar').textContent = `עודכן: ${ts}  ·  ${allLotteries.length} הגרלות`;

    populateCityFilter(data.cities);
    renderLotteries();
  } catch (e) {
    document.getElementById('sync-bar').textContent = 'שגיאה בטעינת נתונים';
    document.getElementById('lottery-tbody').innerHTML = `<tr><td colspan="9" class="error">שגיאה: ${e.message}</td></tr>`;
  }
}

// ── Events ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  init();

  // Header Logo click — Go Home / Reset Filters
  const logoBtn = document.getElementById('header-logo-btn');
  if (logoBtn) {
    logoBtn.addEventListener('click', () => {
      filterCities.clear();
      filterReservist = false;
      filterNoReligious = false;
      filterMaxDays = null;
      
      document.querySelectorAll('.city-chip').forEach(b => b.classList.remove('active'));
      const reservistCheck = document.getElementById('filter-reservist');
      const noReligiousCheck = document.getElementById('filter-no-religious');
      const daysInput = document.getElementById('filter-days');
      if (reservistCheck) reservistCheck.checked = false;
      if (noReligiousCheck) noReligiousCheck.checked = false;
      if (daysInput) daysInput.value = '';
      
      switchTab('lotteries');
      renderLotteries();
      toast('מסננים אופסו');
    });
  }

  // Slider
  const slider = document.getElementById('reservist-slider');
  const sliderLabel = document.getElementById('slider-pct');
  slider.addEventListener('input', () => {
    sliderP = slider.value / 100;
    sliderLabel.textContent = slider.value + '%';
    renderAll();
  });

  // Tab nav
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Sort buttons — lotteries
  document.querySelectorAll('.sort-btn[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      sortKey = btn.dataset.sort;
      document.querySelectorAll('.sort-btn[data-sort]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderLotteries();
    });
  });

  // Sort buttons — cities
  document.querySelectorAll('.sort-btn[data-csort]').forEach(btn => {
    btn.addEventListener('click', () => {
      citySortKey = btn.dataset.csort;
      document.querySelectorAll('.sort-btn[data-csort]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderCities();
    });
  });

  // Checkboxes
  document.getElementById('filter-reservist').addEventListener('change', e => {
    filterReservist = e.target.checked;
    renderLotteries();
  });
  document.getElementById('filter-no-religious').addEventListener('change', e => {
    filterNoReligious = e.target.checked;
    renderLotteries();
  });

  // Days filter
  document.getElementById('filter-days').addEventListener('input', e => {
    filterMaxDays = e.target.value ? parseInt(e.target.value) : null;
    renderLotteries();
  });

  // Clear filters
  document.getElementById('clear-filters').addEventListener('click', () => {
    filterCities.clear(); filterReservist = false; filterNoReligious = false; filterMaxDays = null;
    document.querySelectorAll('.city-chip').forEach(b => b.classList.remove('active'));
    document.getElementById('filter-reservist').checked = false;
    document.getElementById('filter-no-religious').checked = false;
    document.getElementById('filter-days').value = '';
    renderLotteries();
  });

  // Refresh button — 10-min cooldown to avoid WAF rate-limiting
  const REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
  document.getElementById('refresh-btn').addEventListener('click', async () => {
    const passcode = prompt('אנא הזן קוד רענון:');
    if (!passcode) return;
    if (passcode !== 'XXXX') {
      toast('קוד שגוי. הרענון בוטל.');
      return;
    }

    if (window.location.hostname.endsWith('github.io')) {
      toast('רענון ישיר אינו זמין ב-GitHub Pages. הנתונים מתעדכנים אוטומטית (כל 12 שעות).');
      return;
    }
    const btn = document.getElementById('refresh-btn');
    const lastRefresh = parseInt(localStorage.getItem('dira_last_refresh') || '0');
    const sinceLastMs = Date.now() - lastRefresh;
    if (sinceLastMs < REFRESH_COOLDOWN_MS) {
      const minsLeft = Math.ceil((REFRESH_COOLDOWN_MS - sinceLastMs) / 60000);
      toast(`המתן עוד ${minsLeft} דק׳ לפני רענון נוסף`);
      return;
    }
    btn.textContent = '⏳';
    btn.disabled = true;
    localStorage.setItem('dira_last_refresh', Date.now());
    try {
      const res = await fetch(`/refresh?code=${passcode}`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        // Reload data.json and re-render
        const r = await fetch(DATA_URL + '?t=' + Date.now());
        const d = await r.json();
        allLotteries = d.lotteries;
        const ts = d.generated_at ? new Date(d.generated_at).toLocaleString('he-IL') : '—';
        document.getElementById('sync-bar').textContent = `עודכן: ${ts}  ·  ${allLotteries.length} הגרלות`;
        renderAll();
        toast('נתונים עודכנו בהצלחה ✓');
      } else {
        const detail = data.error || (data.scraper || '').slice(-120) || 'שגיאה לא ידועה';
        console.error('Refresh failed:', data);
        toast('שגיאה: ' + detail);
      }
    } catch (e) {
      console.error('Refresh exception:', e);
      toast('שגיאה: ' + e.message);
    } finally {
      btn.textContent = '🔄';
      btn.disabled = false;
    }
  });

  // Settings panel
  document.getElementById('settings-btn').addEventListener('click', () => {
    renderMarketPriceList();
    document.getElementById('overlay').classList.add('show');
    document.getElementById('settings-panel').classList.add('open');
  });
  const closeSettings = () => {
    document.getElementById('overlay').classList.remove('show');
    document.getElementById('settings-panel').classList.remove('open');
  };
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('overlay').addEventListener('click', closeSettings);

  document.getElementById('reset-prices').addEventListener('click', () => {
    marketPrices = JSON.parse(JSON.stringify(marketBase));
    localStorage.removeItem(LS_KEY);
    renderMarketPriceList();
    renderAll();
    toast('מחירים אופסו');
  });

  // Row detail panel
  const closeRow = () => {
    document.getElementById('row-overlay').classList.remove('show');
    document.getElementById('row-panel').classList.remove('open');
  };
  document.getElementById('row-close').addEventListener('click', closeRow);
  document.getElementById('row-overlay').addEventListener('click', closeRow);

  // Re-render scatter on resize
  window.addEventListener('resize', () => {
    if (document.getElementById('tab-scatter').classList.contains('active')) renderScatter();
  });
});
