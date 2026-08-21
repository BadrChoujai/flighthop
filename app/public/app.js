// Flighthop client. Filtering and re-ranking happen here so the sliders are instant;
// only a new origin, destination or date range costs a round trip.

import { PlacePicker, DateRange } from '/components.js';

const $ = (id) => document.getElementById(id);
const state = {
  result: null, sort: 'score', pinnedDay: null, expanded: new Set(),
  page: 1, xrows: [], xpage: 1, lastSearchView: 'search',
};
const PER_PAGE = 15;

/* ---------- helpers ---------- */
const hrs = (h) => h >= 1
  ? `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, '0')}m`
  : `${Math.round(h * 60)}m`;

/** Narrow-bar forms. Compact keeps the minutes ("1h25"); short rounds ("1h"). */
const hrsCompact = (h) => h >= 1
  ? `${Math.floor(h)}h${String(Math.round((h % 1) * 60)).padStart(2, '0')}`
  : `${Math.round(h * 60)}m`;
const hrsShort = (h) => (h >= 1 ? `${Math.round(h)}h` : `${Math.round(h * 60)}m`);

/* A label that does not fit its segment gets clipped at both ends, and a clipped
   "3h 20m in Barcelona" reads as a 20-minute connection. So measure the text and
   step down to a shorter form — or to nothing — rather than let it be cut. */
const gauge = document.createElement('canvas').getContext('2d');
let gaugeFont = '600 11px monospace';

function textWidth(t) {
  gauge.font = gaugeFont;
  return gauge.measureText(t).width;
}

function fitBarLabels() {
  const bars = [...document.querySelectorAll('.bars')];
  if (!bars.length) return;

  const probe = bars[0].querySelector('b');
  if (probe) {
    const cs = getComputedStyle(probe);
    gaugeFont = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  }

  const measured = bars.map(bar => ({ bar, width: bar.clientWidth }));   // read
  const placed = [];
  for (const { bar, width } of measured) {                              // then write
    const segs = [...bar.children];
    const total = segs.reduce((sum, el) => sum + Number(el.dataset.flex), 0);
    for (const el of segs) {
      const room = (Number(el.dataset.flex) / total) * width - 14;
      const candidates = JSON.parse(el.dataset.labels);
      const pick = candidates.findIndex(t => textWidth(t) <= room);
      el.querySelector('b').textContent = pick < 0 ? '' : candidates[pick];
      if (pick >= 0) placed.push({ el, candidates, pick });
    }
  }

  // Canvas measurement is close but not exact. Anything still overflowing steps
  // down for real — nothing gets clipped, ever.
  for (const { el, candidates, pick } of placed) {
    const label = el.querySelector('b');
    for (let n = pick; label.scrollWidth > el.clientWidth; n++) {
      label.textContent = candidates[n + 1] ?? '';
      if (n + 1 >= candidates.length) break;
    }
  }
}

let refitTimer;
addEventListener('resize', () => {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(fitBarLabels, 120);
});

const money = (v, c) => (c === 'EUR' ? '€' : c + ' ') + Math.round(v);

const dayName = (iso) => new Date(iso + 'T12:00:00Z')
  .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

function iso(d) { return d.toISOString().slice(0, 10); }

/* ---------- pickers ---------- */
const pickers = {
  from: new PlacePicker($('fromPicker')),
  to: new PlacePicker($('toPicker'), { places: true }),
  xfrom: new PlacePicker($('xfromPicker')),
  xcountry: new PlacePicker($('xcountryPicker'), { places: true }),
};
const ranges = {
  search: new DateRange($('rangePicker')),
  explore: new DateRange($('xrangePicker')),
};

let airports = [];
const airportsReady = fetch('/api/airports').then(r => r.json()).then(list => {
  airports = list;
  Object.values(pickers).forEach(p => p.load(list));
});

/* ---------- default origin: wherever the visitor is ----------
   The server reads this from the request rather than asking the browser for
   location permission on page load. If it cannot tell, the field stays empty
   and the placeholder does the work. */
airportsReady.then(() => fetch('/api/where').then(r => r.json())).then(({ known, airport }) => {
  if (!known || !airport) return;
  for (const key of ['from', 'xfrom']) {
    if (!pickers[key].value) pickers[key].choose(airport.code, { silent: true });
  }
}).catch(() => { /* an unfilled field is a fine outcome */ });

/* ---------- default dates: from today, a month wide ---------- */
{
  const start = new Date();
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 30);
  ranges.search.set(iso(start), iso(end));
  ranges.explore.set(iso(start), iso(end));
}

/* The hero arcs draw themselves in. The dash length has to be the real path
   length, or the line either stops short or starts already visible — so measure
   it rather than guessing a number in the stylesheet. */
for (const path of document.querySelectorAll('.art-hop')) {
  path.style.setProperty('--len', path.getTotalLength());
}

/* ---------- theme ----------
   Light is the default. A choice is remembered; no choice means light, whatever
   the operating system prefers. */
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('themeToggle').setAttribute('aria-label',
    theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  try { localStorage.setItem('flighthop:theme', theme); } catch { /* session only */ }
}
$('themeToggle').onclick = () =>
  setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
setTheme(document.documentElement.getAttribute('data-theme') ?? 'light');

/* ---------- views ---------- */
const VIEWS = [
  ['home', 'view-home', null],
  ['search', 'view-search', 'searchForm'],
  ['explore', 'view-explore', 'exploreForm'],
  ['info', 'view-info', null],
];

function showTab(which) {
  const previous = document.querySelector('[id^="view-"]:not(.hidden)')?.id;
  for (const [name, view, form] of VIEWS) {
    const on = which === name;
    $(view).classList.toggle('hidden', !on);
    if (form) $(form).classList.toggle('hidden', !on);
  }
  if (which !== 'info') state.lastSearchView = which;   // includes home

  $('tab-search').setAttribute('aria-selected', String(which === 'search'));
  $('tab-explore').setAttribute('aria-selected', String(which === 'explore'));
  $('tab-info').setAttribute('aria-pressed', String(which === 'info'));
  $('tab-info').textContent = which === 'info' ? 'Back to search' : 'How it works';
  document.body.classList.toggle('reading', which === 'info');
  document.body.classList.toggle('landing', which === 'home');

  // Replay the entrance animation when the view actually changes, so switching
  // reads as movement rather than an instant swap.
  if (previous !== `view-${which}`) {
    const el = $(`view-${which}`);
    el.classList.remove('rise');
    void el.offsetWidth;                 // restart the animation
    el.classList.add('rise');
    el.addEventListener('animationend', () => el.classList.remove('rise'), { once: true });
    scrollTo({ top: 0, behavior: 'smooth' });
  }
}

$('tab-search').onclick = () => showTab('search');
$('tab-explore').onclick = () => showTab('explore');

// A toggle: pressing it again returns you to whichever view you came from.
$('tab-info').onclick = () => showTab(
  $('tab-info').getAttribute('aria-pressed') === 'true' ? state.lastSearchView : 'info');

$('home').onclick = () => showTab('home');
$('heroSearch').onclick = () => showTab('search');
$('heroSearch2').onclick = () => showTab('search');
$('heroHow').onclick = () => showTab('info');

/* A tag in the results is the natural place to wonder what it means, so make it
   the link to the explanation. */
addEventListener('click', (e) => {
  const chip = e.target.closest('.card .chip');
  if (!chip) return;
  e.stopPropagation();                       // don't also expand the trip
  showTab('info');
  requestAnimationFrame(() => $('tags').scrollIntoView({ behavior: 'smooth', block: 'start' }));
}, true);

/* ---------- rail controls ---------- */
const bind = (id, out, fmt, onChange) => {
  const el = $(id);
  const update = () => { $(out).textContent = fmt(el.value); onChange?.(); };
  el.addEventListener('input', update);
  update();
};
bind('minLayover', 'minLayoutOut', v => `${Number(v).toFixed(1)} h`, () => rerank());
bind('maxLayover', 'maxLayoutOut', v => `${v} h`, () => rerank());
bind('tightPenalty', 'tightOut', v => `€${v}/h`, () => rerank());
bind('longPenalty', 'longOut', v => `€${v}/h`, () => rerank());
bind('maxPrice', 'maxPriceOut', v => (Number(v) === 0 ? 'any' : `€${v}`), () => rerank());
$('noOvernight').addEventListener('change', () => rerank());

$('sortToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-sort]');
  if (!btn) return;
  state.sort = btn.dataset.sort;
  [...$('sortToggle').children].forEach(b =>
    b.setAttribute('aria-pressed', String(b === btn)));
  rerank();
});

bind('xmax', 'xmaxOut', v => `€${v}`);
bind('xafter', 'xafterOut', v => (Number(v) === 0 ? 'any' : `${String(v).padStart(2, '0')}:00`));
bind('xbefore', 'xbeforeOut', v => (Number(v) === 24 ? 'any' : `${String(v).padStart(2, '0')}:00`));

/* ---------- the two-tickets warning ----------
   It has to be read once, not every session forever. Dismissing it sticks, and
   the same point is always one click away on the How it works page. */
const NOTICE_KEY = 'flighthop:notice-dismissed';
const noticeDismissed = () => {
  try { return localStorage.getItem(NOTICE_KEY) === '1'; } catch { return false; }
};
$('noticeClose').onclick = () => {
  $('notice').hidden = true;
  try { localStorage.setItem(NOTICE_KEY, '1'); } catch { /* private mode: shown again next time */ }
};
$('noticeMore').onclick = () => {
  showTab('info');
  requestAnimationFrame(() => $('tags').scrollIntoView({ behavior: 'smooth', block: 'start' }));
};

/* Clicking a day filters the list to it. Clicking the same day again clears it,
   but that is not something anyone discovers — so say so with a button. */
$('monthReset').onclick = () => {
  state.pinnedDay = null;
  renderMonth();
  rerank();
};

/* ---------- pagination ----------
   Shared by both listings. Renders nothing at all for a single page. */
function renderPager(el, total, current, onGo) {
  const pages = Math.ceil(total / PER_PAGE);
  if (pages <= 1) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');

  // First, last, and a window around the current page — with gaps marked.
  const window_ = new Set([1, pages, current, current - 1, current + 1]);
  if (current <= 3) [2, 3, 4].forEach(n => window_.add(n));
  if (current >= pages - 2) [pages - 1, pages - 2, pages - 3].forEach(n => window_.add(n));
  const shown = [...window_].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);

  let html = `<button class="pg-step" data-go="${current - 1}" ${current === 1 ? 'disabled' : ''}
                aria-label="Previous page">‹ Previous</button><span class="pg-nums">`;
  let prev = 0;
  for (const n of shown) {
    if (n - prev > 1) html += '<span class="pg-gap">…</span>';
    html += `<button class="pg-num${n === current ? ' current' : ''}" data-go="${n}"
               ${n === current ? 'aria-current="page"' : ''}>${n}</button>`;
    prev = n;
  }
  html += `</span><button class="pg-step" data-go="${current + 1}" ${current === pages ? 'disabled' : ''}
             aria-label="Next page">Next ›</button>`;
  el.innerHTML = html;

  el.onclick = (e) => {
    const btn = e.target.closest('[data-go]');
    if (!btn || btn.disabled) return;
    onGo(Number(btn.dataset.go));
  };
}

/* ---------- search ---------- */
$('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch();
});

function setPhase(phase) {
  $('idle').classList.toggle('hidden', phase !== 'idle');
  $('loading').classList.toggle('hidden', phase !== 'loading');
  $('failure').classList.toggle('hidden', phase !== 'failed');
  const showResults = phase === 'done';
  $('resultHead').classList.toggle('hidden', !showResults);
  $('monthPanel').classList.toggle('hidden', !showResults);
  $('notice').hidden = !showResults || noticeDismissed();
  if (!showResults) { $('pager').classList.add('hidden'); $('pager').innerHTML = ''; }
  if (phase !== 'done') $('results').innerHTML = '';
}

let stream = null;
function runSearch() {
  stream?.close();
  state.pinnedDay = null;
  state.expanded.clear();
  state.page = 1;
  setPhase('loading');
  $('goBtn').disabled = true;
  $('progressBar').style.width = '0%';
  $('progressText').textContent = '';
  $('loadingSub').textContent = 'Building the route graph…';

  const q = new URLSearchParams({
    from: pickers.from.commit(), to: pickers.to.commit(),
    dateFrom: ranges.search.from, dateTo: ranges.search.to,
    minLayover: $('minLayover').value, maxLayover: $('maxLayover').value,
  });

  stream = new EventSource('/api/search?' + q);

  // The server reports every phase, not just hub pricing — building the route
  // graph is most of the wait on a country search, and silence there reads as a
  // hang. Each phase owns a slice of the bar so it only ever moves forwards.
  const PHASES = {
    airports: { headline: 'Searching the network', from: 0, to: 5 },
    graph: { headline: 'Searching the network', from: 5, to: 15 },
    inbound: { headline: 'Working out what connects', from: 15, to: 35 },
    direct: { headline: 'Checking direct flights', from: 35, to: 45 },
    hubs: { headline: 'Pricing every connection', from: 45, to: 100 },
  };

  stream.addEventListener('progress', (e) => {
    const p = JSON.parse(e.data);
    const phase = PHASES[p.phase] ?? PHASES.hubs;
    const share = p.total ? (p.done ?? 0) / p.total : 0;

    $('loadingSub').textContent = phase.headline;
    $('progressBar').style.width = `${phase.from + (phase.to - phase.from) * share}%`;
    $('progressText').textContent = p.total > 1
      ? `${p.label} · ${p.done} of ${p.total}`
      : p.label;
  });

  stream.addEventListener('result', (e) => {
    state.result = JSON.parse(e.data);
    stream.close();
    $('goBtn').disabled = false;
    setPhase('done');
    renderMonth();
    render();
  });

  stream.addEventListener('failed', (e) => {
    const { message } = JSON.parse(e.data);
    stream.close();
    $('goBtn').disabled = false;
    setPhase('failed');
    $('failMsg').textContent = message;
  });

  stream.onerror = () => {
    stream.close();
    $('goBtn').disabled = false;
    setPhase('failed');
    $('failMsg').textContent = 'Lost the connection to the search. Try again.';
  };
}

/* ---------- filtering and ranking, client side ---------- */
function visible() {
  const r = state.result;
  if (!r) return [];
  const min = Number($('minLayover').value);
  const max = Number($('maxLayover').value);
  const cap = Number($('maxPrice').value);
  const hideNight = $('noOvernight').checked;
  const tight = Number($('tightPenalty').value);
  const long = Number($('longPenalty').value);

  const scored = [...r.direct, ...r.itineraries]
    .filter(it => it.kind === 'direct' || (it.layover >= min && it.layover <= max))
    .filter(it => !cap || it.price <= cap)
    .filter(it => !(hideNight && it.flags?.some(f => f.id === 'overnight')))
    .filter(it => !state.pinnedDay || it.legs[0].depDate === state.pinnedDay)
    .map(it => {
      if (it.kind === 'direct') return { ...it, score: it.price };
      const overnight = it.flags.some(f => f.id === 'overnight');
      const border = it.flags.some(f => f.id === 'border');
      const penalty =
        (it.layover < 3 ? (3 - it.layover) * tight : 0) +
        (it.layover > 8 ? (it.layover - 8) * long : 0) +
        (overnight ? 60 : 0) + (border ? 30 : 0);
      return { ...it, score: it.price + penalty };
    });

  const key = state.sort;
  scored.sort((a, b) => (a[key] ?? a.price) - (b[key] ?? b.price));
  return scored;
}

/* Any change to filters or sorting invalidates which page you were on. Declared
   as a function so the rail bindings can call it while the module is still
   evaluating. */
function rerank() {
  state.page = 1;
  render();
}

/* ---------- rendering ---------- */
function render() {
  if (!state.result) return;
  const rows = visible();
  const r = state.result;

  // A country search resolves to a list of airports, but "13 airports" is not what
  // the person typed. Name the country when they all share one.
  const dest = (() => {
    if (r.targets.length === 1) {
      return airports.find(a => a.code === r.targets[0])?.city ?? r.targets[0];
    }
    const countries = new Set(r.targets.map(c => airports.find(a => a.code === c)?.country));
    return countries.size === 1
      ? [...countries][0]
      : `${r.targets.length} airports`;
  })();
  $('resultTitle').textContent = `${airports.find(a => a.code === r.origin)?.city ?? r.origin} → ${dest}`;

  if (!rows.length) {
    $('resultCount').textContent =
      `none of ${r.direct.length + r.itineraries.length} match · ${r.meta.hubsSearched} hubs searched`;
    $('results').innerHTML = `<div class="state">
      <h3>Nothing matches those limits</h3>
      <p>The cheapest trip that does exist is ${money(Math.min(...[...r.direct, ...r.itineraries].map(i => i.price)) || 0, r.currency)}.
         Try a longer maximum layover, or raise the budget.</p></div>`;
    renderPager($('pager'), 0, 1, () => {});
    return;
  }

  const pages = Math.ceil(rows.length / PER_PAGE);
  state.page = Math.min(Math.max(1, state.page), pages);
  const start = (state.page - 1) * PER_PAGE;
  const page = rows.slice(start, start + PER_PAGE);

  $('resultCount').textContent =
    `${start + 1}–${start + page.length} of ${rows.length} · ${r.meta.hubsSearched} hubs searched` +
    (state.pinnedDay ? ` · ${dayName(state.pinnedDay)} only` : '');

  // Bar widths stay comparable across pages by scaling to the whole result set,
  // not to whichever trips happen to be on screen.
  const maxSpan = Math.max(...rows.map(i => i.total));
  $('results').innerHTML = page.map((it, i) => card(it, i, maxSpan)).join('');
  fitBarLabels();

  renderPager($('pager'), rows.length, state.page, (n) => {
    state.page = n;
    render();
    $('resultHead').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function card(it, i, maxSpan) {
  const id = `${it.kind}-${it.legs.map(l => l.from + l.day + l.depLocal).join('-')}`;
  const open = state.expanded.has(id);
  const width = Math.max(18, (it.total / maxSpan) * 100);

  // Longest label first; fitBarLabels() picks the first one that fits the segment.
  const seg = (cls, flex, labels) =>
    `<div class="seg ${cls}" style="flex:${flex}" data-flex="${flex}"
          data-labels='${JSON.stringify(labels).replace(/'/g, '&apos;')}'><b></b></div>`;

  const flyLabels = (d) => [hrs(d), hrsCompact(d), hrsShort(d)];

  const bars = it.kind === 'direct'
    ? seg('seg-fly', 1, [`${hrs(it.total)} nonstop`, ...flyLabels(it.total)])
    : seg('seg-fly', it.legs[0].duration, flyLabels(it.legs[0].duration)) +
      seg('seg-wait', it.layover, [
        `${hrs(it.layover)} in ${it.hubCity ?? it.hubName}`,
        `${hrs(it.layover)} in ${it.hub}`,
        ...flyLabels(it.layover),
      ]) +
      seg('seg-fly', it.legs[1].duration, flyLabels(it.legs[1].duration));

  const chip = it.kind === 'direct'
    ? '<span class="chip chip-direct">direct</span>'
    : `<span class="chip chip-${it.level}">${it.level}</span>`;

  // The wait sits between the legs here too, so the itinerary is still readable
  // when the bar is too narrow to caption.
  const legLine = it.kind === 'direct'
    ? `<b>${it.legs[0].from} ${it.legs[0].depLocal}</b> → <b>${it.legs[0].to} ${it.legs[0].arrLocal}</b>`
    : `<b>${it.legs[0].from} ${it.legs[0].depLocal}</b> → <b>${it.legs[0].to} ${it.legs[0].arrLocal}</b>` +
      ` &nbsp;·&nbsp; <span class="wait-inline">wait ${hrs(it.layover)}</span> &nbsp;·&nbsp; ` +
      `<b>${it.legs[1].from} ${it.legs[1].depLocal}</b> → <b>${it.legs[1].to} ${it.legs[1].arrLocal}</b>`;

  return `<div class="card ${open ? 'open' : ''}" data-id="${id}" data-i="${i}">
    <div class="price">${money(it.price, it.currency)}
      <small>${dayName(it.legs[0].depDate)}${it.kind === 'direct' ? '' : ` · via <span class="via">${it.hub}</span>`}</small>
    </div>
    <div class="track">
      <div class="bars" style="width:${width}%">${bars}</div>
      <div class="legs">
        <span>${legLine}</span>
        <span>${chip} &nbsp; ${hrs(it.total)} door to door</span>
      </div>
    </div>
    ${open ? detail(it) : ''}
  </div>`;
}

function detail(it) {
  const legs = it.legs.map((l, n) => `
    <div class="leg-box">
      <span class="k">${it.kind === 'direct' ? 'Flight' : `Leg ${n + 1}`}</span>
      <div class="route">${l.from} ${l.depLocal} → ${l.to} ${l.arrLocal}</div>
      <div class="sub">${dayName(l.depDate)} · ${hrs(l.duration)} · ${money(l.price, l.currency)}${l.flight ? ` · ${l.flight}` : ''}</div>
      <a class="book" href="${l.book}" target="_blank" rel="noopener">Book this leg on Ryanair</a>
    </div>`).join('');

  const flags = (it.flags ?? []).map(f => `<span class="flag">${f.label}</span>`).join('');

  let backup = '';
  if (it.kind === 'connection') {
    if (it.backup) {
      backup = `<div class="backup">If the first flight runs late: <b>${it.backup.flight}</b> leaves ${it.hub} at
        <b>${it.backup.depLocal}</b> the same day. You would be buying a new ticket for it.</div>`;
    } else if (it.backup === null) {
      backup = `<div class="backup">${it.hub} → ${it.legs[1].to} flies once that day. Miss it and the next one is tomorrow.</div>`;
    } else {
      backup = '<div class="backup">No published timetable for the second leg, so we cannot tell you whether a later flight exists.</div>';
    }
  }

  return `<div class="detail">
    <div class="detail-grid">${legs}</div>
    ${flags ? `<div class="flags">${flags}</div>` : ''}
    ${backup}
  </div>`;
}

$('results').addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const card = e.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
  render();
});

/* ---------- month heat map ---------- */
function renderMonth() {
  const month = state.result.month;
  const days = Object.keys(month).sort();
  const grid = $('monthGrid');
  grid.innerHTML = '';
  if (!days.length) { $('monthPanel').classList.add('hidden'); return; }

  const prices = days.map(d => month[d].price);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  $('monthTitle').textContent = state.pinnedDay
    ? `Showing ${dayName(state.pinnedDay)} only`
    : `Best price per departure day · ${money(lo, state.result.currency)} to ${money(hi, state.result.currency)}`;
  $('monthReset').classList.toggle('hidden', !state.pinnedDay);

  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(d => {
    const el = document.createElement('div');
    el.className = 'dow';
    el.textContent = d;
    grid.appendChild(el);
  });

  const first = new Date(days[0] + 'T00:00:00Z');
  const lead = (first.getUTCDay() + 6) % 7;
  for (let i = 0; i < lead; i++) {
    const gap = document.createElement('div');
    gap.className = 'day empty';
    grid.appendChild(gap);
  }

  const cursor = new Date(first);
  const last = new Date(days[days.length - 1] + 'T00:00:00Z');
  while (cursor <= last) {
    const key = iso(cursor);
    const entry = month[key];
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'day' + (entry?.price === lo ? ' best' : '');
    if (entry) {
      const t = hi === lo ? 0 : Math.pow((entry.price - lo) / (hi - lo), 0.6);
      cell.style.background = `color-mix(in oklab, var(--accent) ${Math.round((1 - t) * 42)}%, var(--surface-2))`;
      cell.title = `${dayName(key)} · ${money(entry.price, state.result.currency)}` +
                   (entry.hub ? ` via ${entry.hub}, ${hrs(entry.layover)} wait` : ' nonstop');
      cell.innerHTML = `<span class="n">${cursor.getUTCDate()}</span><span class="p">${money(entry.price, state.result.currency)}</span>`;
      cell.setAttribute('aria-pressed', String(state.pinnedDay === key));
      cell.onclick = () => {
        state.pinnedDay = state.pinnedDay === key ? null : key;
        renderMonth();
        rerank();
      };
    } else {
      cell.disabled = true;
      cell.innerHTML = `<span class="n">${cursor.getUTCDate()}</span><span class="p" style="color:var(--muted)">—</span>`;
    }
    grid.appendChild(cell);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

/* ---------- explore ---------- */
function renderExplore() {
  const rows = state.xrows;
  if (!rows.length) {
    $('xresults').innerHTML = '';
    $('xcount').textContent = '';
    renderPager($('xpager'), 0, 1, () => {});
    return;
  }

  const pages = Math.ceil(rows.length / PER_PAGE);
  state.xpage = Math.min(Math.max(1, state.xpage), pages);
  const start = (state.xpage - 1) * PER_PAGE;
  const page = rows.slice(start, start + PER_PAGE);

  $('xcount').textContent = `${start + 1}–${start + page.length} of ${rows.length} destinations`;
  $('xresults').innerHTML = `<table>
    <thead><tr><th>Fare</th><th>Where</th><th>Country</th><th>Departs</th><th>Flight</th><th></th></tr></thead>
    <tbody>${page.map(r => `<tr>
      <td class="num">${money(r.price, r.currency)}</td>
      <td><strong>${r.city}</strong> <span style="color:var(--muted)">${r.code}</span>${r.newRoute ? ' <span class="chip chip-direct">new</span>' : ''}</td>
      <td style="color:var(--ink-2)">${r.country}</td>
      <td class="dim">${dayName(r.day)} ${r.depLocal}→${r.arrLocal}</td>
      <td class="dim">${r.flight}</td>
      <td><a class="book" href="${r.book}" target="_blank" rel="noopener">Book</a></td>
    </tr>`).join('')}</tbody></table>`;

  renderPager($('xpager'), rows.length, state.xpage, (n) => {
    state.xpage = n;
    renderExplore();
    $('xhead').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}


$('exploreForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const after = Number($('xafter').value), before = Number($('xbefore').value);
  const q = new URLSearchParams({
    from: pickers.xfrom.commit(),
    dateFrom: ranges.explore.from, dateTo: ranges.explore.to,
    maxPrice: $('xmax').value,
  });
  if (pickers.xcountry.commit()) q.set('country', pickers.xcountry.value);
  if (after > 0) q.set('after', `${String(after).padStart(2, '0')}:00`);
  if (before < 24) q.set('before', `${String(before).padStart(2, '0')}:00`);

  $('xidle').classList.remove('hidden');
  $('xidle').innerHTML = '<h3>Asking the network</h3><p>One request, every destination.</p>';
  $('xresults').innerHTML = '';

  try {
    const res = await fetch('/api/explore?' + q);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);

    $('xidle').classList.add('hidden');
    $('xhead').classList.remove('hidden');
    const scope = pickers.xcountry.value || 'anywhere';
    $('xtitle').textContent = `${airports.find(a => a.code === data.origin)?.city ?? data.origin} → ${scope} under €${$('xmax').value}`;

    state.xrows = data.rows;
    state.xpage = 1;
    renderExplore();

    if (!data.rows.length) {
      $('xidle').classList.remove('hidden');
      $('xidle').innerHTML = '<h3>Nothing under that fare</h3><p>Raise the budget or widen the dates.</p>';
    }
  } catch (err) {
    $('xidle').classList.remove('hidden');
    $('xidle').innerHTML = `<h3 style="color:var(--risk)">That search did not work</h3><p>${err.message}</p>`;
  }
});
