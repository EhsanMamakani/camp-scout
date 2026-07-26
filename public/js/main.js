// Bootstrap: load metadata, wire the search form, render the org root map.

import { state, resetScan } from './state.js';
import {
  fetchParks, fetchRootMaps, fetchAttributes, fetchEquipment, fetchIconLabels, startScan,
} from './api.js';
import { initMap, showOrgRoot, refreshCurrentView } from './map.js';
import { renderResults } from './results.js';

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- search form

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function defaultDates() {
  // next Friday to Sunday
  const now = new Date();
  const fri = new Date(now);
  fri.setDate(now.getDate() + ((5 - now.getDay() + 7) % 7 || 7));
  const sun = new Date(fri);
  sun.setDate(fri.getDate() + 2);
  return [fmtDate(fri), fmtDate(sun)];
}

function nightsBetween(start, end) {
  return Math.round((Date.parse(end) - Date.parse(start)) / 864e5);
}

function updateNightsNote() {
  const s = $('#start-date').value;
  const e = $('#end-date').value;
  const note = $('#nights-note');
  const n = s && e ? nightsBetween(s, e) : 0;
  if (!s || !e || n < 1) {
    note.textContent = 'Depart must be after arrive (depart = checkout day)';
    return null;
  }
  note.textContent = `${n} night${n > 1 ? 's' : ''}. A site must be free on every one to count as available`;
  return n;
}

function readCriteria() {
  const startDate = $('#start-date').value;
  const endDate = $('#end-date').value;
  const nights = updateNightsNote();
  if (!nights || nights > 30) return null;
  const dates = Array.from({ length: nights }, (_, i) =>
    new Date(Date.parse(startDate) + i * 864e5).toISOString().slice(0, 10));
  return {
    startDate,
    endDate,
    nights,
    dates,
    subEquipmentId: parseInt($('#equipment').value, 10),
    partySize: Math.max(1, parseInt($('#party-size').value, 10) || 1),
  };
}

function initSearchForm() {
  const [defStart, defEnd] = defaultDates();
  const today = fmtDate(new Date());
  const start = $('#start-date');
  const end = $('#end-date');
  start.value = defStart;
  start.min = today;
  end.value = defEnd;
  end.min = today;
  updateNightsNote();

  start.addEventListener('change', () => {
    if (end.value <= start.value) {
      const d = new Date(Date.parse(start.value) + 864e5);
      end.value = fmtDate(d);
    }
    end.min = start.value;
    updateNightsNote();
  });
  end.addEventListener('change', updateNightsNote);

  const eqSel = $('#equipment');
  eqSel.innerHTML = state.equipment
    .map((e) => `<option value="${e.subEquipmentId}">${e.name}</option>`)
    .join('');
  eqSel.value = '-32768'; // Single Tent

  document.querySelectorAll('.step').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $('#party-size');
      input.value = Math.min(100, Math.max(1, (parseInt(input.value, 10) || 1) + Number(btn.dataset.step)));
    });
  });

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runScan();
  });
}

// ---------------------------------------------------------------- scan flow

let refreshTimer = null;

function runScan() {
  const criteria = readCriteria();
  if (!criteria) return;

  resetScan();
  state.criteria = criteria;
  state.scan.running = true;
  state.scan.error = null;

  const btn = $('#scan-btn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  $('#scan-progress').hidden = false;
  $('#bar-fill').style.width = '0%';
  $('#progress-text').textContent = 'Contacting Ontario Parks…';
  renderResults();

  const scheduleRefresh = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      renderResults();
      refreshCurrentView(); // update link badges / site colours in place
    }, 1200);
  };

  state.scan.handle = startScan(criteria, (ev) => {
    if (ev.type === 'start') {
      state.scan.total = ev.total;
      $('#progress-text').textContent = `Scanning ${ev.total} parks…`;
    } else if (ev.type === 'park') {
      state.scan.results.set(ev.parkId, ev);
      if (ev.freeTotal > 0) scheduleRefresh();
    } else if (ev.type === 'progress') {
      state.scan.done = ev.done;
      const pct = state.scan.total ? Math.round((ev.done / state.scan.total) * 100) : 0;
      $('#bar-fill').style.width = pct + '%';
      const found = [...state.scan.results.values()].reduce((s, p) => s + (p.freeTotal || 0), 0);
      $('#progress-text').textContent = `${ev.done}/${state.scan.total} parks · ${found} whole-stay sites found`;
    } else if (ev.type === 'done') {
      finishScan(`Done in ${(ev.elapsedMs / 1000).toFixed(0)}s`);
    } else if (ev.type === 'fatal') {
      state.scan.error = ev.error;
      finishScan('Scan failed: ' + ev.error);
    }
  });
}

function finishScan(msg) {
  state.scan.running = false;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  const btn = $('#scan-btn');
  btn.disabled = false;
  btn.textContent = 'Scan all parks';
  $('#progress-text').textContent = msg;
  renderResults();
  refreshCurrentView();
}

// ---------------------------------------------------------------- boot

async function boot() {
  initMap();

  const [parks, rootMaps, attrs, equipment, iconLabels] = await Promise.all([
    fetchParks(), fetchRootMaps(), fetchAttributes(), fetchEquipment(), fetchIconLabels(),
  ]);

  state.parks = parks;
  state.parksById = new Map(parks.map((p) => [p.parkId, p]));
  state.rootMaps = rootMaps;
  state.orgRootMap = rootMaps.find((m) => m.isOrgRoot) || rootMaps[0];
  for (const m of rootMaps) state.mapsById.set(m.mapId, m);

  // parkId -> region map (the org root's direct children partition the parks)
  const regionMaps = new Map(
    state.orgRootMap.links.map((l) => [l.childMapId, state.mapsById.get(l.childMapId)]).filter(([, m]) => m),
  );
  const assign = (m, region) => {
    for (const l of m.links) {
      if (l.parkId != null && !state.regionByParkId.has(l.parkId)) {
        state.regionByParkId.set(l.parkId, region);
      } else if (l.parkId == null && state.mapsById.has(l.childMapId)) {
        const child = state.mapsById.get(l.childMapId);
        if (child && child.mapId !== m.mapId) assign(child, region);
      }
    }
  };
  for (const [, rm] of regionMaps) if (rm) assign(rm, rm);

  state.attrDefs = new Map(attrs.map((a) => [a.defId, a]));
  state.equipment = equipment;
  state.iconLabels = iconLabels;

  initSearchForm();
  renderResults();
  await showOrgRoot();
}

boot().catch((e) => {
  console.error(e);
  const el = document.querySelector('#results');
  el.innerHTML = `<p class="results-hint">Failed to load Ontario Parks data: ${e.message}.
    Is the server able to reach reservations.ontarioparks.ca?</p>`;
});
