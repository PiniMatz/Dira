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
let filterOnlyRecent = true;

// User Profile settings (local storage persistent)
let userIsReservist = true;
let userIsCombat    = false;
let userLocalCity   = '';

// Active detail panel tracking
let activeDetailPid = null;
let activeDetailLid = null;

// Theme settings (persistent)
let currentTheme = localStorage.getItem('dira_theme') || 'dark';
function applyTheme() {
  const isLight = currentTheme === 'light';
  if (isLight) {
    document.body.classList.add('light-theme');
  } else {
    document.body.classList.remove('light-theme');
  }
  const textEl = document.getElementById('theme-btn-text');
  const iconEl = document.getElementById('theme-btn-icon');
  if (textEl && iconEl) {
    textEl.textContent = isLight ? 'מצב כהה' : 'מצב בהיר';
    iconEl.textContent = isLight ? '🌙' : '☀️';
  }
}
applyTheme();

// City enlistment/service eligibility rates (Knesset Research Center report, Jan 2026)
const CITY_ELIGIBILITY = {
  // Haredi
  'מודיעין עילית': 0.09,
  'ביתר עילית': 0.07,
  'בני ברק': 0.09,
  'אלעד': 0.09,
  'רכסים': 0.05,
  'עמנואל': 0.02,
  'קרית יערים': 0.05,
  'קריית יערים': 0.05,
  
  // Arab / Bedouin (Very low)
  'אום אל-פחם': 0.02,
  'נצרת': 0.06,
  'סחנין': 0.07,
  'סח\'נין': 0.07,
  'טייבה': 0.02,
  'שפרעם': 0.14,
  'טמרה': 0.04,
  'עראבה': 0.02,
  'קלאנסווה': 0.02,
  'קלנסווה': 0.02,
  'באקה אל-גרביה': 0.02,
  'ריינה': 0.12,
  'כפר כנא': 0.05,
  'ג\'דיידה-מכר': 0.05,
  'ערערה': 0.01,
  'מג\'ד אל-כרום': 0.04,
  'אבו גוש': 0.04,
  'עין מאהל': 0.04,
  'משהד': 0.03,
  'כאבול': 0.07,
  'כפר קאסם': 0.03,
  'ג\'סר א-זרקא': 0.05,
  'חורה': 0.09,
  'כסיפה': 0.18,
  'לקיה': 0.08,
  'ערערה-בנגב': 0.19,
  'רהט': 0.14,
  'שגב-שלום': 0.15,
  'תל שבע': 0.23,
  'בועיינה-נוג\'ידאת': 0.09,
  'כפר מנדא': 0.18,
  'אבו סנאן': 0.18,
  'עילוט': 0.12,
  'אעבלין': 0.06,
  'נחף': 0.12,
  'דייר אל-אסד': 0.11,
  'בענה': 0.10,
  'יפיע': 0.05,
  'דבורייה': 0.05,
  'ג\'לג\'וליה': 0.02,
  'בסמ\"ה': 0.01,
  'בסמת טבעון': 0.29,
  'טובא-זנגרייה': 0.37,
  'כעביה-טבאש-חג\'אג\'רה': 0.43,
  'ביר אל-מכסור': 0.41,
  'שבלי - אום אל-גנם': 0.41,
  'זרזיר': 0.44,
  
  // Mixed / Druze (Medium-High)
  'בית ג\'ן': 0.68,
  'יאנוח-ג\'ת': 0.67,
  'כסרא-סמיע': 0.34,
  'ירכא': 0.30,
  'מגאר': 0.73,
  'חורפיש': 0.75,
  'סאג\'ור': 0.29,
  'ע\'ג\'ר': 0.27,
  
  // Cities with significant Haredi populations but mixed
  'בית שמש': 0.45,
  'ירושלים': 0.50,
  'צפת': 0.55,
  'נתיבות': 0.65,
  'אופקים': 0.75,
  'חצור הגלילית': 0.75,
};

function getEligibilityRate(city) {
  return CITY_ELIGIBILITY[city] ?? 0.85;
}

// City reservist overall population density (IDF spokesperson report, June 2026)
const CITY_RESERVIST_DENSITY = {
  'תל אביב - יפו': 8.7,
  'תל אביב-יפו': 8.7,
  'ירושלים': 2.2,
  'ראשון לציון': 6.2,
  'באר שבע': 6.8,
  'חיפה': 4.7
};
const NATIONAL_AVG_DENSITY = 3.5;

function getCityReservistRatio(city, baseP) {
  const density = CITY_RESERVIST_DENSITY[city];
  if (density === undefined) {
    // Fallback: Scale using enlistment eligibility rate compared to secular baseline of 0.85
    const eRate = getEligibilityRate(city);
    return baseP * (eRate / 0.85);
  }
  return baseP * (density / NATIONAL_AVG_DENSITY);
}

// ── Odds engine ────────────────────────────────────────────────────────────────
function computeOdds(lot, p) {
  const A  = lot.apartments_for_eligible || 0;
  const ah = lot.handicapped_units || 0;
  const ac = lot.reserve_combat_units || 0;
  const ar = lot.reserve_active_units || 0;
  const al = lot.local_housing_units || 0;
  const N  = lot.participants_count ?? lot.registrants ?? 0;
  const N_local = lot.registrants_local || 0;

  if (N <= 0 || A <= 0) return { pini: null, baseline: null, eRate: 0.85, p_city: p, N_eligible: 0, N_local_eligible: 0, ao_updated: 0, W_local: 0, R_reservist: 0 };

  // Enlistment eligibility rate for the city
  const eRate = getEligibilityRate(lot.city);

  // Apply service-requirement deflators
  const N_eligible = N * eRate;
  const N_local_eligible = N_local * eRate;

  // New Baseline: probability under the new eligibility constraint
  const baseline = Math.min(1, A / N_eligible);

  // City-specific reservist ratio scaled by IDF density statistics
  const p_city = getCityReservistRatio(lot.city, p);

  // Stage 2: Combat reservists quota
  const p_combat_city = 0.5 * p_city;
  const R_combat = Math.max(ac, p_combat_city * N);
  const P_combat = ac > 0 ? Math.min(1, ac / R_combat) : 0;

  // Stage 3: Active reservists quota
  const R = Math.max(ar, p_city * N - ac);
  const P_active = ar > 0 ? Math.min(1, ar / R) : 0;

  // Stage 4: Local resident quota
  const W_local = Math.min(al, N_local_eligible);
  const P_local = al > 0 ? Math.min(1, al / N_local_eligible) : 0;

  // Stage 5: General open pool
  const ao_updated = Math.max(0, A - (ah + ac + ar + W_local));
  const openCompetitors = Math.max(ao_updated, N_eligible - (ah + ac + ar + W_local));
  const P_open = ao_updated > 0 ? Math.min(1, ao_updated / openCompetitors) : 0;

  // Calculate cumulative failure probability across stages
  let p_fail = 1.0;

  if (userIsReservist) {
    if (userIsCombat) {
      // Combat Reservist: Stage 2 -> Stage 3 -> Stage 4 (if local) -> Stage 5
      p_fail *= (1 - P_combat);
      p_fail *= (1 - P_active);
    } else {
      // Active Reservist (Non-combat): Stage 3 -> Stage 4 (if local) -> Stage 5
      p_fail *= (1 - P_active);
    }
  }

  if (lot.city === userLocalCity) {
    // Local resident: Stage 4
    p_fail *= (1 - P_local);
  }

  // Everyone enters the general open pool
  p_fail *= (1 - P_open);

  const pini = 1 - p_fail;

  return { 
    pini: Math.min(1, pini), 
    baseline: Math.min(1, baseline),
    eRate,
    p_city,
    N_eligible: Math.round(N_eligible),
    N_local_eligible: Math.round(N_local_eligible),
    ao_updated: Math.round(ao_updated),
    W_local: Math.round(W_local),
    R_reservist: Math.round(R)
  };
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
  date:   dStr => {
    if (!dStr) return '—';
    const y = dStr.slice(2, 4);
    const m = dStr.slice(5, 7);
    const d = dStr.slice(8, 10);
    return `${d}/${m}/${y}`;
  },
  dateTime: dtStr => {
    if (!dtStr) return '—';
    const y = dtStr.slice(2, 4);
    const m = dtStr.slice(5, 7);
    const d = dtStr.slice(8, 10);
    const time = dtStr.slice(11, 16);
    return `${d}/${m}/${y} ${time}`;
  },
  shortPrice: v => {
    if (v == null || isNaN(v)) return '—';
    if (v >= 1000000) {
      return '₪' + Number((v / 1000000).toFixed(2)) + 'M';
    }
    if (v >= 1000) {
      return '₪' + Math.round(v / 1000) + 'K';
    }
    return '₪' + Math.round(v);
  },
  priceRange100: (min, max) => {
    if (!min && !max) return '—';
    const min100 = min ? min * 100 : null;
    const max100 = max ? max * 100 : null;
    if (!min100) return fmt.shortPrice(max100);
    if (!max100) return fmt.shortPrice(min100);
    if (Math.round(min100) === Math.round(max100)) return fmt.shortPrice(min100);
    return `${fmt.shortPrice(min100)} – ${fmt.shortPrice(max100)}`;
  }
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
  let maxEndDate = '';
  if (allLotteries.length > 0) {
    maxEndDate = allLotteries.reduce((max, l) => {
      if (!l.signup_end_date) return max;
      return l.signup_end_date > max ? l.signup_end_date : max;
    }, '');
  }

  return allLotteries.filter(l => {
    if (filterOnlyRecent) {
      const isFutureOrLatest = !l.signup_end_date || l.signup_end_date >= maxEndDate || new Date(l.signup_end_date) >= Date.now();
      if (!isFutureOrLatest) return false;
    }
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
    const isDrawn = !!l.lottery_date;
    const days = isDrawn ? null : daysToClose(l);
    let daysText = '—';
    let daysCellClass = '';
    if (isDrawn) {
      daysText = `הוגרלה (${fmt.date(l.lottery_date)})`;
      daysCellClass = 'days-drawn';
    } else if (days !== null) {
      if (days < 0) {
        daysText = 'ממתין לתוצאות';
        daysCellClass = 'days-closed';
      } else {
        daysText = days;
        daysCellClass = daysClass(days);
      }
    }
    const trClass = isDrawn ? 'row-drawn' : (days !== null && days < 0 ? 'row-closed' : '');
    return `<tr class="${trClass}" onclick="openRowPanel(${l.project_id}, ${l.lottery_id})" data-pid="${l.project_id}" data-lid="${l.lottery_id}">
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
      <td>${fmt.num(l.participants_count ?? l.registrants)}</td>
      <td class="${daysCellClass}">${daysText}</td>
    </tr>`;
  }).join('');

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
  
  const anyOpen = lots.some(l => {
    const d = daysToClose(l);
    return d !== null && d >= 0 && !l.lottery_date;
  });
  
  const elTotalLabel = document.querySelector('.stat-card:first-child .stat-label');
  if (elTotalLabel) {
    elTotalLabel.textContent = anyOpen ? 'הגרלות פתוחות' : 'הגרלות במעקב';
  }
  
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
    
    const minPrice = prices.length ? Math.min(...prices) : null;
    const maxPrice = prices.length ? Math.max(...prices) : null;
    const aggOdds = cityAggregate(lots, sliderP);
    
    const mkt = marketPrices[city]?.market_per_meter;
    const mktPrice100 = mkt ? mkt * 100 : null;
    
    let expectedSaving = 0;
    let expectedRoi = 0;
    
    if (mktPrice100 && minPrice && maxPrice && aggOdds) {
      const avgLotPrice100 = ((minPrice + maxPrice) / 2) * 100;
      const saving100 = Math.max(0, mktPrice100 - avgLotPrice100);
      expectedSaving = aggOdds * saving100;
      expectedRoi = aggOdds * (saving100 / avgLotPrice100) * 100;
    }
    
    return {
      city, lots,
      count:     lots.length,
      totalApts: lots.reduce((s, l) => s + (l.apartments_for_eligible || 0), 0),
      totalActive: lots.reduce((s, l) => s + (l.reserve_active_units || 0), 0),
      minPrice, maxPrice,
      avgDiscount: discs.length ? discs.reduce((s, v) => s + v, 0) / discs.length : null,
      bestOdds:  piniOdds.length ? Math.max(...piniOdds) : null,
      aggOdds,
      expectedSaving,
      expectedRoi
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
      case 'expected_saving': return b.expectedSaving - a.expectedSaving;
      case 'expected_roi':    return b.expectedRoi - a.expectedRoi;
      default: return 0;
    }
  });

  const wrap = document.getElementById('city-cards');
  wrap.innerHTML = stats.map(s => {
    const mkt = marketPrices[s.city]?.market_per_meter;
    const mktPrice100 = mkt ? mkt * 100 : null;
    
    let saving100 = null;
    if (mktPrice100 && s.minPrice && s.maxPrice) {
      const avgLotPrice100 = ((s.minPrice + s.maxPrice) / 2) * 100;
      saving100 = Math.max(0, mktPrice100 - avgLotPrice100);
    }

    return `
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
        <div class="city-price-comparison">
          <div class="price-comp-row">
            <span class="price-comp-label">דירת 100 מ״ר בהגרלה:</span>
            <span class="price-comp-value lot-price">${fmt.priceRange100(s.minPrice, s.maxPrice)}</span>
          </div>
          <div class="price-comp-row">
            <span class="price-comp-label">מחיר שוק מוערך:</span>
            <span class="price-comp-value market-price">${fmt.shortPrice(mktPrice100)}</span>
          </div>
          <div class="price-comp-row saving-row">
            <span class="price-comp-label">חיסכון משוער:</span>
            <span class="price-comp-value saving-value">${fmt.shortPrice(saving100)}</span>
          </div>
          <div class="price-comp-row expected-row" style="border-top: 1px dashed var(--border); padding-top: 6px; margin-top: 6px;">
            <span class="price-comp-label">תוחלת חיסכון (100 מ״ר):</span>
            <span class="price-comp-value expected-saving" style="font-weight: 700; color: var(--blue);">${fmt.shortPrice(s.expectedSaving)}</span>
          </div>
          <div class="price-comp-row expected-row">
            <span class="price-comp-label">תוחלת תשואה:</span>
            <span class="price-comp-value expected-roi" style="font-weight: 700; color: var(--indigo);">${s.expectedRoi.toFixed(2)}%</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}


// ── Row detail panel ───────────────────────────────────────────────────────────
function openRowPanel(pid, lid) {
  const l = allLotteries.find(x => x.project_id === pid && x.lottery_id === lid);
  if (!l) return;
  activeDetailPid = pid;
  activeDetailLid = lid;
  const { pini, baseline, eRate, p_city, N_eligible, N_local_eligible, ao_updated, W_local, R_reservist } = computeOdds(l, sliderP);
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
      <div class="row-section-label">סיכויים וחוק השירות</div>
      ${field('שיעור זכאות עירוני', fmt.pct(eRate))}
      ${field('אחוז מילואים עירוני משוער', fmt.pct(p_city))}
      ${field('סיכוי בסיס (משודרג)', fmt.pct(baseline))}
      ${field('סיכוי מצטבר בעיר', fmt.pct(cityAggregate(allLotteries.filter(x => x.city === l.city), sliderP)))}
    </div>

    <div class="row-section">
      <div class="row-section-label">דירות</div>
      ${field('דירות לזכאים', l.apartments_for_eligible)}
      ${field('מילואים פעילים', l.reserve_active_units)}
      ${field('מילואים לוחמים', l.reserve_combat_units)}
      ${field('בני מקום (הקצאה)', l.local_housing_units)}
      ${field('בני מקום שחולקו (מוערך)', W_local)}
      ${field('נכים', l.handicapped_units)}
      ${field('הגרלה כללית (משודרג)', ao_updated)}
    </div>

    <div class="row-section">
      <div class="row-section-label">מחיר וערך</div>
      ${field('מחיר/מ׳ (הגרלה)', fmt.price(l.price_per_meter))}
      ${field('מחיר/מ׳ (שוק)', mkt ? fmt.price(mkt) : '—')}
      ${field('הנחה משוק', fmt.pct(disc))}
    </div>

    <div class="row-section">
      <div class="row-section-label">רישום</div>
      ${field(l.lottery_date ? 'רשומים סה״כ (סופי)' : 'רשומים סה״כ', fmt.num(N))}
      ${field('רשומים זכאים (משוער)', fmt.num(N_eligible))}
      ${l.registrants_reserve_duty > 0 ? field('מתחרי מילואים (בפועל)', fmt.num(l.registrants_reserve_duty)) : field('מתחרי מילואים (מוערך)', fmt.num(R_reservist))}
      ${l.registrants_combat > 0 ? field('מילואים לוחמים (בפועל)', fmt.num(l.registrants_combat)) : ''}
      ${field(l.lottery_date ? 'מקומיים רשומים (סופי)' : 'מקומיים רשומים', fmt.num(l.registrants_local))}
      ${field('מקומיים זכאים (משוער)', fmt.num(N_local_eligible))}
      ${l.lottery_date ? field('סטטוס הגרלה', 'הוגרלה 🎉') : field('ימים לסגירה', days ?? '—')}
      ${l.lottery_date ? field('תאריך הגרלה', fmt.dateTime(l.lottery_date)) : field('תאריך סיום', fmt.date(l.signup_end_date))}
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

function switchTab(name) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name)?.classList.add('active');
  document.querySelector(`.nav-tab[data-tab="${name}"]`)?.classList.add('active');
  
  const mainEl = document.getElementById('main');
  if (mainEl) mainEl.scrollTop = 0;

  if (name === 'cities')   renderCities();
  if (name === 'formulas') updateFormulasTab();
}

// ── Render all ─────────────────────────────────────────────────────────────────
function renderAll() {
  renderLotteries();
  const activeTab = document.querySelector('.tab-pane.active')?.id.replace('tab-', '');
  if (activeTab === 'cities')  renderCities();
  if (activeDetailPid !== null && activeDetailLid !== null) {
    openRowPanel(activeDetailPid, activeDetailLid);
  }
}

function updateSliderWidgetState() {
  const widget = document.querySelector('.slider-widget');
  if (widget) {
    if (userIsReservist) {
      widget.classList.remove('disabled');
    } else {
      widget.classList.add('disabled');
    }
  }
}

// ── Personal Profile settings persistence ──
const PROFILE_LS_KEY = 'dira_user_profile';

function saveUserProfile() {
  const profile = {
    userIsReservist,
    userIsCombat,
    userLocalCity
  };
  localStorage.setItem(PROFILE_LS_KEY, JSON.stringify(profile));
}

function loadUserProfile() {
  const raw = localStorage.getItem(PROFILE_LS_KEY);
  if (raw) {
    try {
      const profile = JSON.parse(raw);
      userIsReservist = profile.userIsReservist ?? true;
      userIsCombat = profile.userIsCombat ?? false;
      userLocalCity = profile.userLocalCity ?? '';
    } catch (e) {
      console.error('Failed to parse user profile', e);
    }
  }
}

function populateLocalCityDropdown(cities) {
  const select = document.getElementById('user-local-city');
  if (!select) return;
  select.innerHTML = '<option value="">— לא בן מקום —</option>';
  const sorted = [...cities].sort((a, b) => a.localeCompare(b, 'he'));
  for (const city of sorted) {
    const opt = document.createElement('option');
    opt.value = city;
    opt.textContent = city;
    select.appendChild(opt);
  }
}

function updateFormulasTab() {
  const titleEl = document.getElementById('formula-title');
  const descEl = document.getElementById('formula-desc');
  const boxEl = document.getElementById('formula-box');
  if (!titleEl || !descEl || !boxEl) return;

  let title = '🛡️ סיכוי שלי — ';
  let desc = '';
  let box = '';

  if (userIsReservist) {
    if (userIsCombat) {
      title += 'לוחם מילואים';
    } else {
      title += 'משרת מילואים פעיל (עורף)';
    }
  } else {
    title += 'לא משרת מילואים';
  }

  if (userLocalCity) {
    title += ` + בן מקום ב${userLocalCity}`;
  } else {
    title += ' (לא בן מקום)';
  }

  box += `━━ סינון נרשמים זכאים ━━\n`;
  box += `N_eligible = N × E_city\n`;
  box += `N_local_eligible = N_local × E_city\n\n`;

  if (userIsReservist) {
    box += `━━ התאמת אחוז מילואים עירוני (p_city) ━━\n`;
    box += `p_city = p × (Density_city / 3.5)       [בערים עם נתונים מדווחים]\n`;
    box += `p_city = p × (E_city / 0.85)             [בכל שאר הערים]\n\n`;
  }

  let stagesList = [];
  let mathP = [];

  if (userIsReservist) {
    if (userIsCombat) {
      stagesList.push('שלב 2 (מכסת לוחמים)');
      stagesList.push('שלב 3 (מכסת מילואים עורף/פעילים)');
      box += `━━ שלב 2: מכסת לוחמים ━━\n`;
      box += `p_combat_city = 0.5 × p_city\n`;
      box += `R_combat = max(ac, p_combat_city × N_eligible)\n`;
      box += `P_combat = ac / R_combat                  [אם ac > 0]\n\n`;
      mathP.push('P_combat');
    } else {
      stagesList.push('שלב 3 (מכסת מילואים עורף/פעילים)');
    }
    box += `━━ שלב 3: מכסת משרתי עורף ━━\n`;
    box += `R_active = max(ar, p_city × N_eligible − ac)\n`;
    box += `P_active = ar / R_active                  [אם ar > 0]\n\n`;
    mathP.push('P_active');
  }

  if (userLocalCity) {
    stagesList.push('שלב 4 (מכסת בני מקום)');
    box += `━━ שלב 4: מכסת בני מקום ━━\n`;
    box += `P_local = al / N_local_eligible           [אם al > 0 בעיר המגורים שלך]\n\n`;
    mathP.push('P_local');
  }

  stagesList.push('שלב 5 (הגרלה כללית)');
  box += `━━ שלב 4 (כללי): עודף בני מקום (זרימה כללית) ━━\n`;
  box += `W_local = min(al, N_local_eligible)\n`;
  box += `ao_updated = max(0, A − ah − ac − ar − W_local)\n\n`;
  box += `━━ שלב 5: הגרלה כללית מותאמת ━━\n`;
  box += `openComp = max(ao_updated, N_eligible − ah − ac − ar − W_local)\n`;
  box += `P_open = ao_updated / openComp            [אם ao_updated > 0]\n\n`;
  mathP.push('P_open');

  desc = `חישוב סיכוי אישי עוקב המבוסס על שלבי ההגרלה הרלוונטיים לפרופיל שלך: ${stagesList.join(' ← ')}.`;
  if (userIsReservist) {
    desc += ` מקדם המילואים העירוני (p_city) מותאם אישית לפי צפיפות המילואימניקים בעיר על פי נתוני צה"ל 2025.`;
  }

  box += `━━ סיכוי כולל (חישוב הסתברות משלימה) ━━\n`;
  if (mathP.length === 1) {
    box += `סיכוי שלי = ${mathP[0]}`;
  } else {
    const pTerms = mathP.map(p => `(1 − ${p})`).join(' × ');
    box += `סיכוי שלי = 1 − ${pTerms}`;
  }

  titleEl.textContent = title;
  descEl.textContent = desc;
  boxEl.textContent = box;

  // Update stage list HTML
  const stageListEl = document.getElementById('formula-stage-list');
  if (stageListEl) {
    let stageHtml = '';
    
    // Stage 1
    stageHtml += `<li><span class="stage-num">1</span><span class="stage-label">נכים רתוקים <small>(ah דירות)</small></span></li>`;
    
    // Stage 2
    if (userIsReservist && userIsCombat) {
      stageHtml += `<li><span class="stage-num mine">2</span><span class="stage-label"><strong>לוחמי מילואים — 45+ ימי שירות מ-7.10.23 <small>(ac דירות)</small></strong> ← השלב שלך</span></li>`;
    } else {
      stageHtml += `<li><span class="stage-num">2</span><span class="stage-label">לוחמי מילואים — 45+ ימי שירות מ-7.10.23 <small>(ac דירות)</small></span></li>`;
    }
    
    // Stage 3
    if (userIsReservist) {
      stageHtml += `<li><span class="stage-num mine">3</span><span class="stage-label"><strong>משרתי עורף — מילואים לא-לוחמים <small>(ar דירות)</small></strong> ← השלב שלך</span></li>`;
    } else {
      stageHtml += `<li><span class="stage-num">3</span><span class="stage-label">משרתי עורף — מילואים לא-לוחמים <small>(ar דירות)</small></span></li>`;
    }
    
    // Stage 4
    if (userLocalCity) {
      stageHtml += `<li><span class="stage-num mine">4</span><span class="stage-label"><strong>בני מקום — תושבי היישוב <small>(al דירות)</small></strong> [מקומי ב-${userLocalCity}] ← השלב שלך</span></li>`;
    } else {
      stageHtml += `<li><span class="stage-num">4</span><span class="stage-label">בני מקום — תושבי היישוב <small>(al דירות)</small></span></li>`;
    }
    
    // Stage 5
    stageHtml += `<li><span class="stage-num mine">5</span><span class="stage-label"><strong>הגרלה כללית — כל שאר הזכאים <small>(ao דירות)</small></strong> ← השלב שלך</span></li>`;
    
    stageListEl.innerHTML = stageHtml;
  }

  // Update stage route note text
  const stageNoteEl = document.getElementById('formula-stage-note');
  if (stageNoteEl) {
    let pathList = [];
    if (userIsReservist) {
      if (userIsCombat) {
        pathList.push('שלב 2 (לוחמים)');
      }
      pathList.push('שלב 3 (עורף/פעילים)');
    }
    if (userLocalCity) {
      pathList.push('שלב 4 (בני מקום)');
    }
    pathList.push('שלב 5 (כללית)');
    stageNoteEl.innerHTML = `המסלול האישי שלך: ${pathList.map(s => `<strong>${s}</strong>`).join(' ← אם לא זכית ← ')}. אין עדיפות בתוך שלב 5 — כולם מתחרים שווה.`;
  }
}

function initUserProfileDOM(cities) {
  populateLocalCityDropdown(cities);
  
  const checkReservist = document.getElementById('user-reservist');
  const checkCombat = document.getElementById('user-combat');
  const selectLocalCity = document.getElementById('user-local-city');
  
  if (checkReservist) {
    checkReservist.checked = userIsReservist;
  }
  if (checkCombat) {
    checkCombat.checked = userIsCombat;
    checkCombat.disabled = !userIsReservist;
  }
  if (selectLocalCity) {
    selectLocalCity.value = userLocalCity;
  }
  
  updateFormulasTab();
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

function updateSyncBar(ts, count) {
  const el = document.getElementById('sync-bar');
  if (!el) return;
  el.innerHTML = `
    <span>עודכן: ${ts}</span>
    <span class="sync-divider">·</span>
    <span>${count} הגרלות</span>
    <span class="sync-divider">·</span>
    <span dir="ltr">Created by <a href="https://www.linkedin.com/in/pini-matzner-phd-95a51813/" target="_blank" class="footer-link">Pini Matzner</a></span>
  `;
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
    updateSyncBar(ts, allLotteries.length);

    populateCityFilter(data.cities);
    loadUserProfile();
    initUserProfileDOM(data.cities);
    updateSliderWidgetState();
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
  let renderTimeout = null;
  slider.addEventListener('input', () => {
    sliderP = slider.value / 100;
    sliderLabel.textContent = slider.value + '%';
    
    // Auto-enable reservist mode if they interact with the slider
    if (!userIsReservist) {
      userIsReservist = true;
      const checkReservist = document.getElementById('user-reservist');
      if (checkReservist) {
        checkReservist.checked = true;
      }
      const checkCombat = document.getElementById('user-combat');
      if (checkCombat) {
        checkCombat.disabled = false;
      }
      saveUserProfile();
      updateSliderWidgetState();
      updateFormulasTab();
    }
    
    if (renderTimeout) cancelAnimationFrame(renderTimeout);
    renderTimeout = requestAnimationFrame(() => {
      renderAll();
    });
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

  // Profile settings
  const checkReservist = document.getElementById('user-reservist');
  const checkCombat = document.getElementById('user-combat');
  const selectLocalCity = document.getElementById('user-local-city');

  if (checkReservist) {
    checkReservist.addEventListener('change', e => {
      userIsReservist = e.target.checked;
      if (!userIsReservist) {
        userIsCombat = false;
        if (checkCombat) {
          checkCombat.checked = false;
          checkCombat.disabled = true;
        }
      } else {
        if (checkCombat) {
          checkCombat.disabled = false;
        }
      }
      saveUserProfile();
      updateSliderWidgetState();
      renderAll();
      updateFormulasTab();
    });
  }

  if (checkCombat) {
    checkCombat.addEventListener('change', e => {
      userIsCombat = e.target.checked;
      saveUserProfile();
      renderAll();
      updateFormulasTab();
    });
  }

  if (selectLocalCity) {
    selectLocalCity.addEventListener('change', e => {
      userLocalCity = e.target.value;
      saveUserProfile();
      renderAll();
      updateFormulasTab();
    });
  }

  // Checkboxes
  document.getElementById('filter-recent').addEventListener('change', e => {
    filterOnlyRecent = e.target.checked;
    renderLotteries();
  });
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
    filterCities.clear(); filterReservist = false; filterNoReligious = false; filterMaxDays = null; filterOnlyRecent = true;
    document.querySelectorAll('.city-chip').forEach(b => b.classList.remove('active'));
    document.getElementById('filter-recent').checked = true;
    document.getElementById('filter-reservist').checked = false;
    document.getElementById('filter-no-religious').checked = false;
    document.getElementById('filter-days').value = '';
    renderLotteries();
  });

  // Theme Toggle
  const themeBtn = document.getElementById('theme-toggle-btn');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('dira_theme', currentTheme);
      applyTheme();
    });
  }

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
    activeDetailPid = null;
    activeDetailLid = null;
  };
  document.getElementById('row-close').addEventListener('click', closeRow);
  document.getElementById('row-overlay').addEventListener('click', closeRow);

  // Event delegation for table rows (lottery-tbody)
  const tbody = document.getElementById('lottery-tbody');
  if (tbody) {
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (tr && tr.dataset.pid && tr.dataset.lid) {
        openRowPanel(parseInt(tr.dataset.pid), parseInt(tr.dataset.lid));
      }
    });
  }

  // Event delegation for city cards (city-cards)
  const cityCardsWrap = document.getElementById('city-cards');
  if (cityCardsWrap) {
    cityCardsWrap.addEventListener('click', (e) => {
      const card = e.target.closest('.city-card');
      if (card && card.dataset.city) {
        filterCities.clear();
        filterCities.add(card.dataset.city);
        document.querySelectorAll('.city-chip').forEach(b => {
          b.classList.toggle('active', filterCities.has(b.dataset.city));
        });
        switchTab('lotteries');
        renderLotteries();
      }
    });
  }


});
