// Two controls the platform does not give us in a usable form: an airport picker
// that searches four fields at once, and a date range picker that treats a whole
// month as a normal answer. No dependencies, no build step.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const iso = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const parse = (s) => new Date(s + 'T00:00:00Z');
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const addMonths = (d, n) => { const x = new Date(d); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n); return x; };
const today = () => parse(new Date().toISOString().slice(0, 10));

const fmtShort = (isoStr) => {
  const d = parse(isoStr);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`;
};

/* ============================ airport picker ============================ */

export class PlacePicker {
  /**
   * @param root  .picker element containing an <input>
   * @param opts  { places: boolean }  — when true, countries are offered too
   */
  constructor(root, { places = false } = {}) {
    this.root = root;
    this.input = root.querySelector('input');
    this.places = places;
    this.items = [];
    this.filtered = [];
    this.active = -1;
    this.open = false;
    this.value = this.input.dataset.value ?? '';

    this.list = document.createElement('div');
    this.list.className = 'pop pop-list';
    this.list.setAttribute('role', 'listbox');
    this.list.hidden = true;
    root.appendChild(this.list);

    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.autocomplete = 'off';

    this.input.addEventListener('focus', () => this.show());
    this.input.addEventListener('input', () => {
      this.query = this.input.value;
      this.value = '';          // typing over a choice invalidates it until re-picked
      this.show();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.list.addEventListener('mousedown', (e) => {
      const row = e.target.closest('[data-code]');
      if (!row) return;
      e.preventDefault();
      this.choose(row.dataset.code);
    });
    for (const type of ['mousedown', 'touchstart']) {
      document.addEventListener(type, (e) => {
        if (!root.contains(e.target)) this.hide();
      }, { passive: true });
    }
  }

  /** @param airports from /api/airports */
  load(airports) {
    this.items = airports.map(a => ({
      kind: 'airport', code: a.code, label: a.city,
      detail: a.city === a.name ? a.country : `${a.name} · ${a.country}`,
      haystack: `${a.code} ${a.city} ${a.name} ${a.country}`.toLowerCase(),
    }));

    if (this.places) {
      const countries = new Map();
      for (const a of airports) {
        const entry = countries.get(a.country) ?? { n: 0 };
        entry.n++;
        countries.set(a.country, entry);
      }
      const asPlaces = [...countries.entries()].map(([country, { n }]) => ({
        kind: 'country', code: country, label: country,
        detail: `${n} airport${n === 1 ? '' : 's'}`,
        haystack: country.toLowerCase(),
      }));
      this.items = [...asPlaces, ...this.items];
    }
    if (this.value) this.choose(this.value, { silent: true });
  }

  choose(code, { silent = false } = {}) {
    const item = this.items.find(i => i.code === code);
    this.value = code;
    this.input.value = item ? (item.kind === 'country' ? item.label : `${item.label} (${item.code})`) : code;
    this.query = '';
    this.hide();
    if (!silent) this.input.dispatchEvent(new CustomEvent('picked', { bubbles: true, detail: { code } }));
  }

  /**
   * Resolve whatever is typed to a real place, for submit handlers. Someone who
   * types "vienna" and hits Search without touching the list means Vienna — not
   * an empty field.
   */
  commit() {
    if (this.value) return this.value;
    const [best] = this.rank(this.input.value);
    if (best) this.choose(best.code, { silent: true });
    return this.value;
  }

  rank(q) {
    if (!q) return [];
    const needle = q.toLowerCase().trim();
    return this.items
      .map(i => {
        let s = -1;
        if (i.code.toLowerCase() === needle) s = 0;
        else if (i.label.toLowerCase().startsWith(needle)) s = 1;
        else if (i.code.toLowerCase().startsWith(needle)) s = 2;
        else if (i.haystack.includes(needle)) s = 3;
        return s < 0 ? null : { ...i, s };
      })
      .filter(Boolean)
      .sort((a, b) => a.s - b.s || a.label.localeCompare(b.label))
      .slice(0, 60);
  }

  show() {
    const q = this.query ?? '';
    this.filtered = this.rank(q);
    this.active = this.filtered.length ? 0 : -1;
    this.render();
    this.open = true;
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
  }

  hide() {
    this.open = false;
    this.list.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    if (this.value) {
      const item = this.items.find(i => i.code === this.value);
      if (item) this.input.value = item.kind === 'country' ? item.label : `${item.label} (${item.code})`;
    }
  }

  render() {
    if (!this.filtered.length) {
      this.list.innerHTML = `<div class="pop-empty">${
        this.query
          ? 'No airport or country matches that'
          : (this.places
              ? 'Type a city, an airport, or a whole country'
              : 'Type a city or an airport')
      }</div>`;
      return;
    }
    let lastKind = null;
    this.list.innerHTML = this.filtered.map((i, n) => {
      const header = i.kind !== lastKind
        ? `<div class="pop-group">${i.kind === 'country' ? 'Whole country' : 'Airports'}</div>` : '';
      lastKind = i.kind;
      return header + `<div class="pop-row${n === this.active ? ' active' : ''}" role="option"
          aria-selected="${n === this.active}" data-code="${i.code}" data-n="${n}">
        <span class="pop-code${i.kind === 'country' ? ' pop-any' : ''}">${i.kind === 'country' ? '◍' : i.code}</span>
        <span class="pop-label">${i.label}</span>
        <span class="pop-detail">${i.detail}</span>
      </div>`;
    }).join('');
    this.list.querySelector('.pop-row.active')?.scrollIntoView({ block: 'nearest' });
  }

  onKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.open) return this.show();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this.active = (this.active + step + this.filtered.length) % this.filtered.length;
      this.render();
    } else if (e.key === 'Enter') {
      if (this.open && this.active >= 0) { e.preventDefault(); this.choose(this.filtered[this.active].code); }
    } else if (e.key === 'Escape') {
      this.hide();
    }
  }
}

/* ============================ date range ============================ */

export class DateRange {
  constructor(root) {
    this.root = root;
    this.button = root.querySelector('button');
    this.from = null;
    this.to = null;
    this.cursor = addMonths(today(), 0);
    this.open = false;

    this.pop = document.createElement('div');
    this.pop.className = 'pop pop-cal';
    this.pop.hidden = true;
    root.appendChild(this.pop);

    this.button.addEventListener('click', () => (this.open ? this.hide() : this.show()));
    this.pop.addEventListener('click', (e) => this.onClick(e));
    this.pop.addEventListener('mouseover', (e) => {
      const cell = e.target.closest('[data-day]');
      if (this.from && !this.to && cell) { this.hover = cell.dataset.day; this.render(); }
    });
    for (const type of ['mousedown', 'touchstart']) {
      document.addEventListener(type, (e) => {
        if (!root.contains(e.target)) this.hide();
      }, { passive: true });
    }
    this.button.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });
  }

  set(from, to) {
    this.from = from; this.to = to;
    this.cursor = addMonths(parse(from), 0);
    this.paint();
  }

  paint() {
    const label = this.root.querySelector('.range-value');
    if (!this.from) { label.textContent = 'Pick dates'; return; }
    const sameYear = this.to && parse(this.from).getUTCFullYear() === parse(this.to).getUTCFullYear();
    label.innerHTML = this.to
      ? `${fmtShort(this.from)} <span class="range-dash">→</span> ${fmtShort(this.to)}` +
        `<span class="range-year"> ${parse(this.to).getUTCFullYear()}${sameYear ? '' : ''}</span>`
      : `${fmtShort(this.from)} <span class="range-dash">→</span> <em>pick an end date</em>`;
  }

  show() { this.open = true; this.pop.hidden = false; this.render(); }
  hide() { this.open = false; this.pop.hidden = true; this.hover = null; }

  onClick(e) {
    const nav = e.target.closest('[data-nav]');
    if (nav) { this.cursor = addMonths(this.cursor, Number(nav.dataset.nav)); return this.render(); }

    const preset = e.target.closest('[data-preset]');
    if (preset) {
      const [start, days] = preset.dataset.preset.split(':');
      let from;
      if (start === 'soon') from = addDays(today(), 14);
      else if (start === 'month') from = addMonths(today(), 1);
      else from = today();
      const to = days === 'month'
        ? addDays(addMonths(from, 1), -1)
        : addDays(from, Number(days) - 1);
      this.from = iso(from); this.to = iso(to);
      this.cursor = addMonths(from, 0);
      this.paint(); this.render();
      this.button.dispatchEvent(new CustomEvent('rangechange', { bubbles: true }));
      return;
    }

    const cell = e.target.closest('[data-day]');
    if (!cell || cell.classList.contains('past')) return;
    const day = cell.dataset.day;
    if (!this.from || this.to || day < this.from) { this.from = day; this.to = null; }
    else { this.to = day; }
    this.hover = null;
    this.paint();
    this.render();
    if (this.from && this.to) {
      this.button.dispatchEvent(new CustomEvent('rangechange', { bubbles: true }));
      setTimeout(() => this.hide(), 160);
    }
  }

  monthGrid(base) {
    const first = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
    const lead = (first.getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
    const now = iso(today());
    const end = this.to ?? (this.from && this.hover > this.from ? this.hover : null);

    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<span class="cal-cell empty"></span>';
    for (let d = 1; d <= days; d++) {
      const key = iso(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), d)));
      const past = key < now;
      const isStart = key === this.from;
      const isEnd = key === this.to;
      const inRange = this.from && end && key > this.from && key < end;
      const cls = ['cal-cell', past ? 'past' : '', isStart ? 'start' : '', isEnd ? 'end' : '',
                   inRange ? 'between' : ''].filter(Boolean).join(' ');
      cells += `<button type="button" class="${cls}" data-day="${key}" ${past ? 'disabled' : ''}>${d}</button>`;
    }
    return `<div class="cal-month">
      <div class="cal-title">${MONTHS[base.getUTCMonth()]} ${base.getUTCFullYear()}</div>
      <div class="cal-grid">${DOW.map(d => `<span class="cal-dow">${d[0]}</span>`).join('')}${cells}</div>
    </div>`;
  }

  render() {
    this.pop.innerHTML = `
      <div class="cal-head">
        <button type="button" class="cal-nav" data-nav="-1" aria-label="Previous month">‹</button>
        <div class="cal-presets">
          <button type="button" data-preset="soon:30">Next 30 days</button>
          <button type="button" data-preset="month:month">Next month</button>
          <button type="button" data-preset="soon:3">A long weekend</button>
        </div>
        <button type="button" class="cal-nav" data-nav="1" aria-label="Next month">›</button>
      </div>
      <div class="cal-months">
        ${this.monthGrid(this.cursor)}
        ${this.monthGrid(addMonths(this.cursor, 1))}
      </div>
      <div class="cal-foot">${this.from && !this.to ? 'Now pick the last day you could fly' : 'Flexibility is the biggest lever on price — a whole month is a fine answer'}</div>`;
  }
}
