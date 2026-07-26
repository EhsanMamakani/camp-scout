// Sidebar results list: parks ranked by number of sites free for the
// whole stay, expandable down to campgrounds and individual site chips.

import { state } from './state.js';
import { showPark } from './map.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MAX_CHIPS = 40;

export function renderResults() {
  const el = $('#results');
  const { scan } = state;

  if (!scan.results.size && !scan.running) {
    el.innerHTML = `<p class="results-hint">Pick your dates and scan. Every park is checked for
      sites free on <em>all</em> of your nights, not just some of them.</p>`;
    return;
  }

  const parks = [...scan.results.values()]
    .filter((p) => p.freeTotal > 0)
    .sort((a, b) => b.freeTotal - a.freeTotal);
  const partialOnly = [...scan.results.values()].filter((p) => !p.freeTotal && p.partialTotal > 0);
  const errors = [...scan.results.values()].filter((p) => p.error);

  const frag = document.createDocumentFragment();

  const head = document.createElement('p');
  head.className = 'results-head';
  const totalFree = parks.reduce((s, p) => s + p.freeTotal, 0);
  head.textContent = scan.running
    ? `Found so far: ${totalFree} sites in ${parks.length} parks`
    : `${totalFree} sites free for your whole stay, in ${parks.length} parks`;
  frag.appendChild(head);

  for (const p of parks) frag.appendChild(parkCard(p));

  if (!scan.running) {
    const note = document.createElement('p');
    note.className = 'no-results';
    if (!parks.length) {
      note.innerHTML = 'No site is free for your <em>entire</em> stay anywhere. Try fewer nights, different dates, or different equipment.';
    } else if (partialOnly.length) {
      note.textContent = `${partialOnly.length} more parks had only partial-stay availability.`;
    }
    if (note.textContent || note.innerHTML) frag.appendChild(note);
    if (errors.length) {
      const err = document.createElement('p');
      err.className = 'no-results';
      err.textContent = `${errors.length} parks could not be scanned (upstream errors).`;
      frag.appendChild(err);
    }
  }

  el.innerHTML = '';
  el.appendChild(frag);
}

function parkCard(p) {
  const card = document.createElement('details');
  card.className = 'park-card';

  const summary = document.createElement('summary');
  summary.innerHTML = `
    <span class="park-name">${esc(shortParkName(p.name))}</span>
    ${p.partialTotal ? `<span class="count-badge partial" title="free some nights only">${p.partialTotal}</span>` : ''}
    <span class="count-badge" title="free for the whole stay">${p.freeTotal}</span>
    <button type="button" class="goto-park" title="open this park on the map">🗺️</button>`;
  summary.querySelector('.goto-park').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showPark(p.parkId);
  });
  card.appendChild(summary);

  for (const cg of p.campgrounds) {
    if (!cg.sites.length) continue;
    const row = document.createElement('div');
    row.className = 'cg-row';
    row.innerHTML = `
      <span class="cg-title">${esc(cg.title)}</span>
      <span class="cg-free">${cg.free} free</span>
      ${cg.partial ? `<span class="cg-partial">+${cg.partial} partial</span>` : ''}`;
    row.querySelector('.cg-title').addEventListener('click', () => showPark(p.parkId, cg.mapId));
    card.appendChild(row);

    const chips = document.createElement('div');
    chips.className = 'site-chips';
    for (const s of cg.sites.slice(0, MAX_CHIPS)) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'site-chip' + (s.fullStay ? '' : ' partial');
      chip.textContent = s.name;
      chip.title = s.fullStay ? 'free for your whole stay; view on map' : 'free some nights; view on map';
      chip.addEventListener('click', () => showPark(p.parkId, cg.mapId, s.resourceId));
      chips.appendChild(chip);
    }
    if (cg.sites.length > MAX_CHIPS) {
      const more = document.createElement('span');
      more.className = 'cg-partial';
      more.textContent = `+${cg.sites.length - MAX_CHIPS} more on the map`;
      chips.appendChild(more);
    }
    card.appendChild(chips);
  }

  return card;
}

const shortParkName = (name) => name.replace(/\s*Provincial Park\s*$/i, '');
