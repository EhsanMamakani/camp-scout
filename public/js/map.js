// Image-map explorer that mirrors the Ontario Parks map hierarchy:
// All Parks, then region, park, campground, all rendered from their own
// map PNGs with Leaflet CRS.Simple. Coordinates in the API are pixel
// (x, y) with y growing downward, so latlng = [h - y, x].

import { state, criteriaKey } from './state.js';
import {
  fetchParkBundle, fetchAvailability, fetchLegendIcons, imgUrl, bookingUrl,
} from './api.js';

let map;                 // L.map instance
let layers = [];         // everything added for the current view
let crumbs = [];         // [{title, mapId, parkId}]
let renderSeq = 0;       // guards against stale async renders adding layers
const legendIconCache = new Map(); // legendItemType -> {dataUri, label}

// Site-marker shapes, extracted verbatim from the official app's shape module.
// A resource's iconType indexes straight into this table (0 Circle "Serviced",
// 1 Triangle "Unserviced", 5 Rhombus "Walk-in", 19 PentagonGap "Yurt", etc).
const SHAPES = {
  0:  { w: 15, h: 15, d: 'M7.5 14.5C11.366 14.5 14.5 11.366 14.5 7.5C14.5 3.63401 11.366 0.5 7.5 0.5C3.63401 0.5 0.5 3.63401 0.5 7.5C0.5 11.366 3.63401 14.5 7.5 14.5Z' },
  1:  { w: 15, h: 15, d: 'M7.5 0L0 15H15L7.5 0Z' },
  2:  { w: 17, h: 17, d: 'M8.5 0L10.8171 6.5671H17L11.9 10.2L14.2953 17L8.5 12.75L2.703 17L5.1 10.2L0 6.5671H6.1812L8.5 0Z' },
  3:  { w: 14, h: 14, d: 'M14 0H0V14H14V0Z' },
  4:  { w: 15, h: 15, d: 'M8 0L16 4.8048V9.63855L8 14.4144L0 9.63855V4.8048L8 0Z' },
  5:  { w: 16, h: 16, d: 'M8 0L0 8L8 16L16 8L8 0Z' },
  6:  { w: 15, h: 15, d: 'M7.5 0L15 7.5V15H0V7.5L7.5 0Z' },
  7:  { w: 15, h: 15, d: 'M8.5 1L10.5445 3.727L14.635 2.3635L13.2715 6.454L16 8.5L13.2715 10.5445L14.635 14.635L10.5445 13.2715L8.5 16L6.454 13.2715L2.3635 14.635L3.727 10.5445L1 8.5L3.727 6.454L2.3635 2.3635L6.454 3.727L8.5 1Z' },
  8:  { w: 15, h: 15, d: 'M7.5 2.727L9.5445 0H12.2715L15 2.727V5.454L12.2715 7.5L15 9.5445V12.2715L12.2715 15H9.5445L7.5 12.2715L5.454 15H2.727L0 12.2715V9.5445L2.727 7.5L0 5.454V2.727L2.727 0H5.454L7.5 2.727Z' },
  9:  { w: 13, h: 22, d: 'M0.510316 16.9231C1.10377 14.6667 6.44489 0 6.44489 0C6.44489 0 11.786 14.6667 12.3795 16.9231C12.9729 19.1795 9.41217 22 6.44489 22C3.4776 22 -0.0831414 19.1795 0.510316 16.9231Z' },
  10: { w: 17, h: 17, d: 'M8.4 17L0.75 5.95L3.3 0H13.5L16.05 5.95L8.4 17Z' },
  11: { w: 15, h: 17, d: 'M7.5 0L9.12336 5.68827L14.8612 4.25L10.7467 8.5L14.8612 12.75L9.12336 11.3117L7.5 17L5.87664 11.3117L0.138784 12.75L4.25329 8.5L0.138784 4.25L5.87664 5.68827L7.5 0Z' },
  12: { w: 15, h: 16, d: 'M5.63271 0H0.964499C0.964499 0 -3.70369 15.5607 7.5 15.5607C18.7037 15.5607 14.0355 0 14.0355 0H9.05607C9.05607 0 12.7906 10.5813 7.5 10.5813C2.20938 10.5813 5.63271 0 5.63271 0Z' },
  13: { w: 11, h: 22, d: 'M6.25 22C9.28757 22 11.75 17.0751 11.75 11C11.75 4.92487 9.28757 0 6.25 0C3.21243 0 0.75 4.92487 0.75 11C0.75 17.0751 3.21243 22 6.25 22Z' },
  14: { w: 15, h: 15, d: 'M7.5 0L15 6.5L13 15H2L0 6.5L7.5 0Z' },
  15: { w: 16, h: 16, d: 'M0 3.58209C0 3.58209 0.716418 0 4 0C7.28358 0 9.31343 3.58209 12.1791 3.58209C15.0448 3.58209 16 0 16 0V10.9702C16 10.9702 15.7612 15.0448 12.1791 15.0448C8.59702 15.0448 6.80597 10.9702 4 10.9702C1.19403 10.9702 0 15.0448 0 15.0448V3.58209Z' },
  16: null,
  17: { w: 15, h: 15, rect: { x: 0, y: 0, w: 15, h: 15, rx: 4 } },
  18: { w: 17, h: 16, d: 'M9.5 1L1 13.2707L9.5 17.1053L18 13.2707L9.5 1Z' },
  19: { w: 15, h: 15, d: 'M1 4.98594V12.9504H7.2794V9.19853H11.3077V12.9504H17.1V4.98594C17.1 4.68316 16.9289 4.41987 16.6524 4.30139L9.35936 1.06296C9.1619 0.983977 8.9381 0.983977 8.7538 1.06296L1.44759 4.28823C1.17114 4.41987 1 4.66999 1 4.97277V4.98594Z' },
  20: { w: 24, h: 12, d: 'M4 3.98221V11.8125H0V11.9733H10.2794V8.19481H14.3077V11.9733H24V11.8125H20.1V3.98221C20.1 3.67943 19.9289 3.41615 19.6524 3.29767L12.3594 0.0592396C12.1619 -0.0197465 11.9381 -0.0197465 11.7538 0.0592396L4.44759 3.2845C4.17114 3.41615 4 3.66627 4 3.96905V3.98221Z' },
  21: { w: 16, h: 16, d: 'M1.27624 6.97521L8.79234 1L16.6995 6.96281C17.2739 7.39669 16.9684 8.31405 16.2596 8.31405H15.013V16H3.07277V8.31405H1.74065C1.04403 8.31405 0.726279 7.40909 1.28846 6.97521H1.27624Z' },
  22: { w: 13, h: 16, d: 'M13.8154 13.35C14.4779 8.4125 7.30286 1 7.30286 1C7.30286 1 0.0028648 8.8 1.11536 13.7375C2.24036 18.675 13.1279 18.2875 13.8029 13.35H13.8154Z' },
  23: { w: 20, h: 13, d: 'M4.57848 11.8333L0.774374 8.72088L10 0.663836L19.2393 8.73282L15.6795 11.8333H4.57848Z' },
  24: { w: 19, h: 18, d: 'M11.6647 1L1 16.8667H6.95L9.262 13.5573L11.574 16.8667H17.524L6.44 1' },
  25: { w: 15, h: 15, d: 'M18,5.2v5.63H0V5.2L8.53,.09c.2-.12,.45-.12,.66,0,0,0,8.81,5.11,8.81,5.11Z' },
  26: { w: 14, h: 14, d: 'M13.3 0H0.7C0.318182 0 0 0.318182 0 0.7V13.3C0 13.6818 0.318182 14 0.7 14H3.5V8.04364H7.7V14H13.3C13.6818 14 14 13.6818 14 13.3V0.7C14 0.318182 13.6818 0 13.3 0Z' },
  27: { w: 15, h: 15, d: 'M1 7.92748V16H16V7.92748L8.30382 1L1 7.92748Z' },
  28: { w: 23, h: 15, d: 'M4 6.92748V14.8281H0V15H23V14.8281H19V6.92748L11.3038 0L4 6.92748Z' },
};

// Official availability palette (from their availability legend).
export const AVAIL_LABELS = [
  { cls: 'free', label: 'Available', sub: 'Available for all selected dates' },
  { cls: 'partial', label: 'Partial Availability', sub: 'Available for some of the selected dates' },
  { cls: 'none', label: 'Unavailable', sub: 'Not available for selected dates' },
];

function shapeSvg(iconType, cls, size = 18, fill = null) {
  const s = SHAPES[iconType] ?? SHAPES[0];
  if (!s) return '';
  const scale = size / Math.max(s.w, s.h);
  const style = fill ? ` style="fill:${fill};stroke:none"` : '';
  const inner = s.rect
    ? `<rect class="icon-shape"${style} x="${s.rect.x}" y="${s.rect.y}" width="${s.rect.w}" height="${s.rect.h}" rx="${s.rect.rx}" ry="${s.rect.rx}" stroke-linejoin="round"/>`
    : `<path class="icon-shape"${style} d="${s.d}"/>`;
  return `<svg class="site-shape ${cls}" viewBox="0 0 ${s.w} ${s.h}" width="${Math.round(s.w * scale)}" height="${Math.round(s.h * scale)}" style="overflow:visible">${inner}</svg>`;
}

// Composite amenity marker exactly like the official map: a coloured tile
// shape (usually a rounded square) with a white glyph PNG on top. Tile and
// glyph live in ONE svg so the glyph is guaranteed to paint over the tile
// (svg paints in document order; separate absolutely-positioned elements
// proved unreliable inside Leaflet's transformed marker pane).
function legendTileHtml(l, icon, size = 18) {
  const s = SHAPES[l.shape ?? 17] ?? SHAPES[17];
  const fill = `rgb(${(l.rgb || [16, 125, 192]).join(',')})`;
  const tile = s.rect
    ? `<rect fill="${fill}" x="${s.rect.x}" y="${s.rect.y}" width="${s.rect.w}" height="${s.rect.h}" rx="${s.rect.rx}" ry="${s.rect.rx}" stroke-linejoin="round"/>`
    : `<path fill="${fill}" d="${s.d}"/>`;
  return `<svg class="legend-tile" viewBox="0 0 ${s.w} ${s.h}" width="${size}" height="${size}" role="img" aria-label="${esc(icon.label)}">`
    + `<title>${esc(icon.label)}</title>${tile}`
    + `<image href="${icon.dataUri}" x="0" y="0" width="${s.w}" height="${s.h}" preserveAspectRatio="xMidYMid meet"/></svg>`;
}

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initMap() {
  map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: -1.5,
    maxZoom: 2.5,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    attributionControl: false,
    wheelPxPerZoomLevel: 90,
  });
}

const showLoading = (on) => { $('#map-loading').hidden = !on; };

function clearLayers() {
  for (const l of layers) l.remove();
  layers = [];
}

const add = (layer) => { layer.addTo(map); layers.push(layer); return layer; };
const toLatLng = (m, x, y) => [m.h - y, x];

// ---------------------------------------------------------------- data access

async function getBundle(parkId) {
  if (state.bundles.has(parkId)) return state.bundles.get(parkId);
  if (!state.bundlePromises.has(parkId)) {
    state.bundlePromises.set(parkId, fetchParkBundle(parkId).then((b) => {
      state.bundles.set(parkId, b);
      for (const m of b.maps) state.mapsById.set(m.mapId, m);
      return b;
    }).catch((e) => {
      state.bundlePromises.delete(parkId);
      throw e;
    }));
  }
  return state.bundlePromises.get(parkId);
}

// Per-site free-night booleans for a map under the current criteria.
// Prefers scan results; falls back to a live availability call.
async function nightsByResource(mapId, parkId) {
  const c = state.criteria;
  if (!c) return null;

  const parkResult = parkId != null ? state.scan.results.get(parkId) : null;
  if (parkResult) {
    const cg = (parkResult.campgrounds || []).find((x) => x.mapId === mapId);
    const out = new Map();
    for (const s of cg?.sites || []) out.set(s.resourceId, s.nights);
    return out; // sites absent from scan results had zero free nights
  }

  const key = `${mapId}|${criteriaKey(c)}`;
  if (state.mapAvailability.has(key)) return state.mapAvailability.get(key);
  const av = await fetchAvailability(mapId, c);
  const out = new Map();
  for (const [rid, arr] of Object.entries(av.resourceAvailabilities || {})) {
    out.set(Number(rid), arr.slice(0, c.nights).map((x) => x && x.availability === 0));
  }
  state.mapAvailability.set(key, out);
  return out;
}

// True when mapId sits under ancestorId in a loaded bundle's map tree.
function isDescendantMap(mapId, ancestorId) {
  let cur = state.mapsById.get(mapId);
  for (let guard = 0; cur && guard < 20; guard++) {
    if (cur.mapId === ancestorId) return true;
    cur = cur.parentMapId != null ? state.mapsById.get(cur.parentMapId) : null;
  }
  return false;
}

// Aggregate free-site count shown on link badges, per link target.
function badgeCount(link, currentMap) {
  if (!state.scan.results.size) return null;

  if (currentMap.isOrgRoot) {
    // region link: sum every scanned park assigned to that region
    let sum = 0;
    for (const [parkId, region] of state.regionByParkId) {
      if (region.mapId === link.childMapId) sum += state.scan.results.get(parkId)?.freeTotal ?? 0;
    }
    return sum;
  }

  const parkId = link.parkId
    ?? currentMap.parkId
    ?? crumbs.findLast((cr) => cr.parkId != null)?.parkId;
  const pr = parkId != null ? state.scan.results.get(parkId) : null;
  if (!pr) return null;

  // Most specific first: the link targets a campground (or a map whose
  // subtree contains campgrounds): sum those counts.
  const matching = (pr.campgrounds || []).filter(
    (c) => c.mapId === link.childMapId || isDescendantMap(c.mapId, link.childMapId),
  );
  if (matching.length) return matching.reduce((s, c) => s + c.free, 0);

  // Link to the park itself (region maps, park selector maps).
  const park = state.parksById.get(parkId);
  if (park && park.rootMapId === link.childMapId) return pr.freeTotal;

  // Target map is inside a loaded bundle and has no free campgrounds: 0.
  // If the bundle isn't loaded we can't tell, so show the park total.
  return state.mapsById.has(link.childMapId) ? 0 : pr.freeTotal;
}

// ---------------------------------------------------------------- rendering

function renderCrumbs() {
  const nav = $('#crumbs');
  nav.innerHTML = '';
  crumbs.forEach((cr, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      nav.appendChild(sep);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'crumb' + (i === crumbs.length - 1 ? ' current' : '');
    b.textContent = cr.title;
    if (i < crumbs.length - 1) b.addEventListener('click', () => navigateToCrumb(i));
    nav.appendChild(b);
  });
}

// Mirrors the official legend's three sections: Availability legend,
// Shape legend (site types on this map), Map Icon Legend (amenity icons).
function renderLegend(mapObj) {
  const el = $('#map-legend');
  const hasSites = mapObj.resources.length > 0;
  const seenTypes = new Map(); // type -> first legend item (for tile shape/colour)
  for (const l of mapObj.legends) if (!seenTypes.has(l.type)) seenTypes.set(l.type, l);
  const iconRows = [...seenTypes.values()]
    .map((l) => ({ l, icon: legendIconCache.get(l.type) }))
    .filter(({ icon }) => icon && icon.dataUri)
    .sort((a, b) => a.icon.label.localeCompare(b.icon.label))
    .map(({ l, icon }) => `<div class="row">${legendTileHtml(l, icon, 18)}${esc(icon.label)}</div>`)
    .join('');
  if (!hasSites && !iconRows) { el.hidden = true; return; }

  const availRows = AVAIL_LABELS.map((a) =>
    `<div class="row"><span class="dot ${a.cls}"></span><span>${a.label}<small>${a.sub}</small></span></div>`).join('');
  const shapeRows = [...new Set(mapObj.resources.map((r) => r.iconType))]
    .sort((a, b) => a - b)
    .map((t) => `<div class="row">${shapeSvg(t, state.criteria ? 'avail-unknown' : 'avail-unknown', 15)}${esc(state.iconLabels[t] || 'Site type ' + t)}</div>`)
    .join('');

  el.innerHTML = `
    ${hasSites ? `<details open><summary>Availability legend</summary>
      ${availRows}
      ${state.criteria ? '' : '<div class="row"><span class="dot unknown"></span><span>Unknown<small>Run a scan for availability</small></span></div>'}
    </details>
    <details open><summary>Shape legend</summary>${shapeRows}</details>` : ''}
    ${iconRows ? `<details ${hasSites ? '' : 'open'}><summary>Map Icon Legend</summary>${iconRows}</details>` : ''}`;
  el.hidden = false;
}

async function loadLegendIcons(mapObj) {
  const missing = [...new Set(mapObj.legends.map((l) => l.type))].filter((t) => !legendIconCache.has(t));
  if (missing.length) {
    try {
      for (const icon of await fetchLegendIcons(missing)) legendIconCache.set(icon.type, icon);
    } catch { /* icons are decoration; carry on */ }
  }
}

function drawLegendIcons(mapObj) {
  for (const l of mapObj.legends) {
    const icon = legendIconCache.get(l.type);
    if (!icon || !icon.dataUri) continue;
    add(L.marker(toLatLng(mapObj, l.x, l.y), {
      icon: L.divIcon({
        className: 'legend-icon',
        html: legendTileHtml(l, icon, 18),
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
      interactive: false,
      keyboard: false,
    }));
  }
}

function drawTextLabels(mapObj) {
  for (const la of mapObj.labels) {
    if (!la.text) continue;
    add(L.marker(toLatLng(mapObj, la.x, la.y), {
      icon: L.divIcon({
        className: 'map-text-label',
        html: `<span style="font-size:${la.fontSize}px;color:rgb(${la.rgb.join(',')});${la.bold ? 'font-weight:700;' : ''}${la.italic ? 'font-style:italic;' : ''}">${esc(la.text)}</span>`,
        iconSize: null,
      }),
      interactive: false,
      keyboard: false,
    }));
  }
}

function drawLinks(mapObj) {
  for (const link of mapObj.links) {
    if (!link.childMapId) continue;
    const go = () => navigateToChild(link);

    if (link.area.length >= 3) {
      const poly = add(L.polygon(link.area.map(([x, y]) => toLatLng(mapObj, x, y)), {
        color: '#285139',
        weight: 1.5,
        opacity: 0,
        fillColor: '#2f8f4e',
        fillOpacity: 0,
        interactive: true,
      }));
      poly.on('mouseover', () => poly.setStyle({ opacity: 0.9, fillOpacity: 0.12 }));
      poly.on('mouseout', () => poly.setStyle({ opacity: 0, fillOpacity: 0 }));
      poly.on('click', go);
    }

    const anchor = link.point
      || (link.area.length
        ? { x: link.area.reduce((s, p) => s + p[0], 0) / link.area.length,
            y: link.area.reduce((s, p) => s + p[1], 0) / link.area.length }
        : null);
    if (!anchor) continue;

    const n = badgeCount(link, mapObj);
    const badge = n == null ? '' : ` <span class="free-n${n === 0 ? ' zero' : ''}">${n}</span>`;
    const marker = add(L.marker(toLatLng(mapObj, anchor.x, anchor.y), {
      icon: L.divIcon({
        className: '',
        html: `<span class="map-link-label" data-link-child="${link.childMapId}">${esc(link.title)}${badge}</span>`,
        iconSize: null,
      }),
      keyboard: false,
    }));
    marker.on('click', go);
  }
}

function siteLabel(name) {
  const s = String(name);
  if (s.length <= 4) return s;
  const digits = s.match(/\d+/);
  return digits ? digits[0].slice(0, 4) : s.slice(0, 3);
}

async function drawSites(mapObj, parkId, focusResourceId, seq) {
  if (!mapObj.resources.length) return;
  const bundle = parkId != null ? await getBundle(parkId).catch(() => null) : null;

  let nights = null;
  if (state.criteria) {
    try { nights = await nightsByResource(mapObj.mapId, parkId); }
    catch { nights = null; }
  }
  if (seq !== renderSeq) return; // user navigated away while we were fetching

  for (const r of mapObj.resources) {
    const meta = bundle?.resources?.[r.resourceId];
    const name = meta?.name || String(r.resourceId);
    let cls = 'avail-unknown';
    if (nights) {
      const nn = nights.get(r.resourceId);
      cls = nn && nn.every(Boolean) ? 'avail-free' : nn && nn.some(Boolean) ? 'avail-partial' : 'avail-none';
    }
    const marker = add(L.marker(toLatLng(mapObj, r.x, r.y), {
      icon: L.divIcon({
        className: '',
        html: `<div class="site-marker" title="${esc(name)}">${shapeSvg(r.iconType, cls, 17)}</div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      }),
      zIndexOffset: cls === 'avail-free' ? 200 : 0,
    }));
    marker.bindPopup(() => sitePopupHtml(mapObj, parkId, r, meta, nights?.get(r.resourceId)), { maxWidth: 300 });

    // The official map draws the site number beside the shape, at the
    // resource's localizationPoint.
    if (r.labelPoint) {
      add(L.marker(toLatLng(mapObj, r.labelPoint.x, r.labelPoint.y), {
        icon: L.divIcon({
          className: 'site-num',
          html: `<span style="color:rgb(${(r.labelPoint.rgb || [0, 0, 0]).join(',')})">${esc(siteLabel(name))}</span>`,
          iconSize: null,
        }),
        interactive: false,
        keyboard: false,
      }));
    }

    if (focusResourceId === r.resourceId) {
      setTimeout(() => {
        map.setView(toLatLng(mapObj, r.x, r.y), 1.5);
        marker.openPopup();
      }, 150);
    }
  }
}

// Photo strip inside the popup: big first photo + thumbnails, all of which
// open the full-size lightbox viewer.
function photoGalleryHtml(meta) {
  const urls = (meta?.photos || []).map(imgUrl);
  if (!urls.length) return '';
  const thumbs = urls.length > 1
    ? `<div class="thumb-row">${urls.slice(1).map((u, i) =>
        `<img class="thumb" loading="lazy" src="${u}" data-idx="${i + 1}" alt="site photo ${i + 2}">`,
      ).join('')}</div>`
    : '';
  return `<div class="gallery" data-photos="${esc(JSON.stringify(urls))}">
    <div class="main-wrap">
      <img class="photo" loading="lazy" src="${urls[0]}" data-idx="0" alt="site photo 1">
      <span class="photo-count">🔍 ${urls.length} photo${urls.length > 1 ? 's' : ''}</span>
    </div>
    ${thumbs}
  </div>`;
}

// ------------------------------------------------------------- lightbox

let lightbox = null;
let lbUrls = [];
let lbIdx = 0;

function ensureLightbox() {
  if (lightbox) return;
  lightbox = document.createElement('div');
  lightbox.id = 'lightbox';
  lightbox.hidden = true;
  lightbox.innerHTML = `
    <button type="button" class="lb-close" aria-label="close">✕</button>
    <button type="button" class="lb-prev" aria-label="previous photo">‹</button>
    <figure><img class="lb-img" alt="site photo"><figcaption class="lb-counter"></figcaption></figure>
    <button type="button" class="lb-next" aria-label="next photo">›</button>`;
  document.body.appendChild(lightbox);

  const close = () => { lightbox.hidden = true; };
  lightbox.querySelector('.lb-close').addEventListener('click', close);
  lightbox.querySelector('.lb-prev').addEventListener('click', () => lbShow(lbIdx - 1));
  lightbox.querySelector('.lb-next').addEventListener('click', () => lbShow(lbIdx + 1));
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox || e.target.tagName === 'FIGURE') close();
  });
  document.addEventListener('keydown', (e) => {
    if (lightbox.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') lbShow(lbIdx - 1);
    else if (e.key === 'ArrowRight') lbShow(lbIdx + 1);
  });
}

function lbShow(idx) {
  lbIdx = (idx + lbUrls.length) % lbUrls.length;
  lightbox.querySelector('.lb-img').src = lbUrls[lbIdx];
  lightbox.querySelector('.lb-counter').textContent = `${lbIdx + 1} / ${lbUrls.length}`;
  const multi = lbUrls.length > 1;
  lightbox.querySelector('.lb-prev').style.visibility = multi ? 'visible' : 'hidden';
  lightbox.querySelector('.lb-next').style.visibility = multi ? 'visible' : 'hidden';
  // pre-load neighbours so arrows feel instant
  if (multi) {
    for (const n of [lbIdx + 1, lbIdx - 1]) {
      new Image().src = lbUrls[(n + lbUrls.length) % lbUrls.length];
    }
  }
}

export function openLightbox(urls, idx = 0) {
  if (!urls.length) return;
  ensureLightbox();
  lbUrls = urls;
  lightbox.hidden = false;
  lbShow(idx);
}

// Popup content is injected by Leaflet as HTML strings, so gallery clicks
// are handled by delegation.
document.addEventListener('click', (e) => {
  const img = e.target.closest('.gallery img');
  if (!img) return;
  const gallery = img.closest('.gallery');
  try {
    openLightbox(JSON.parse(gallery.dataset.photos), Number(img.dataset.idx) || 0);
  } catch { /* bad data attribute, ignore */ }
});

function decodeAttributes(meta) {
  const HIDDEN = new Set([-32718, -32717]); // Northing / Easting: raw UTM, not useful in a popup
  const out = [];
  for (const a of meta.attributes || []) {
    if (HIDDEN.has(a.defId)) continue;
    const def = state.attrDefs.get(a.defId);
    if (!def) continue;
    let value;
    if (a.values && a.values.length) {
      value = a.values.map((v) => def.values[v] ?? v).join(', ');
    } else if (a.value != null) {
      value = def.values[a.value] ?? a.value;
    } else continue;
    out.push({ name: def.name, value: String(value), order: def.order ?? 999 });
  }
  return out.sort((x, y) => x.order - y.order);
}

function sitePopupHtml(mapObj, parkId, r, meta, siteNights) {
  const c = state.criteria;
  const label = state.iconLabels[r.iconType] || '';
  const cap = meta && meta.maxCapacity ? `up to ${meta.maxCapacity} people` : '';
  const equipNames = meta
    ? meta.allowedEquipment
        .map((id) => state.equipment.find((e) => e.subEquipmentId === id)?.name)
        .filter(Boolean)
    : [];

  let nightsHtml = '';
  if (c && siteNights) {
    nightsHtml = '<div class="night-strip">' + c.dates.map((d, i) =>
      `<span class="night-cell ${siteNights[i] ? 'ok' : 'no'}">${d.slice(5).replace('-', '/')}</span>`,
    ).join('') + '</div>';
  } else if (c) {
    nightsHtml = '<p class="popup-note">Not available for any of your nights (or does not fit your equipment/party).</p>';
  } else {
    nightsHtml = '<p class="popup-note">Run a scan to see availability for your dates.</p>';
  }

  const attrs = meta ? decodeAttributes(meta) : [];
  const attrHtml = attrs.length
    ? '<ul class="amenities">' + attrs.map((a) =>
        `<li><span class="k">${esc(a.name)}</span><span class="v">${esc(a.value)}</span></li>`).join('') + '</ul>'
    : '';

  const photo = photoGalleryHtml(meta);

  const book = c && parkId != null
    ? `<a class="book-link" target="_blank" rel="noopener" href="${bookingUrl({ parkId, mapId: mapObj.mapId, criteria: c })}">Book on Ontario Parks ↗</a>`
    : '';

  return `<div class="popup">
    <h3>Site ${esc(meta?.name || r.resourceId)}</h3>
    <p class="popup-sub">${esc([label, cap].filter(Boolean).join(' · '))}</p>
    ${photo}
    ${nightsHtml}
    ${equipNames.length ? `<p class="popup-note">Fits: ${esc(equipNames.join(', '))}</p>` : ''}
    ${attrHtml}
    ${book}
  </div>`;
}

// ---------------------------------------------------------------- navigation

async function renderMap(mapObj, { parkId = null, focusResourceId = null } = {}) {
  const seq = ++renderSeq;
  showLoading(true);
  try {
    clearLayers();
    const bounds = [[0, 0], [mapObj.h, mapObj.w]];
    if (mapObj.imageUrl) add(L.imageOverlay(imgUrl(mapObj.imageUrl), bounds));
    map.setMaxBounds([[-150, -150], [mapObj.h + 150, mapObj.w + 150]]);
    map.fitBounds(bounds);

    drawTextLabels(mapObj);
    drawLinks(mapObj);
    await Promise.all([
      loadLegendIcons(mapObj),
      drawSites(mapObj, parkId, focusResourceId, seq),
    ]);
    if (seq !== renderSeq) return; // a newer view took over mid-flight
    drawLegendIcons(mapObj);
    renderLegend(mapObj);
  } finally {
    if (seq === renderSeq) showLoading(false);
  }
}

async function resolveMap(mapId, parkId) {
  if (state.mapsById.has(mapId)) return state.mapsById.get(mapId);
  if (parkId != null) {
    const bundle = await getBundle(parkId);
    const m = bundle.maps.find((x) => x.mapId === mapId);
    if (m) return m;
    const park = state.parksById.get(parkId);
    const root = bundle.maps.find((x) => x.mapId === park?.rootMapId);
    if (root) return root;
  }
  throw new Error('map not found: ' + mapId);
}

async function navigateToChild(link) {
  const parkId = link.parkId ?? crumbs.findLast((cr) => cr.parkId != null)?.parkId ?? null;
  const title = link.title
    || (link.parkId != null ? state.parksById.get(link.parkId)?.name : '')
    || 'Map';
  crumbs.push({ title, mapId: link.childMapId, parkId });
  await go(link.childMapId, parkId);
}

async function navigateToCrumb(i) {
  crumbs = crumbs.slice(0, i + 1);
  const cr = crumbs[i];
  await go(cr.mapId, cr.parkId);
}

async function go(mapId, parkId, focusResourceId = null) {
  renderCrumbs();
  showLoading(true);
  try {
    const m = await resolveMap(mapId, parkId);
    await renderMap(m, { parkId: parkId ?? m.parkId ?? null, focusResourceId });
  } catch (e) {
    console.error(e);
    showLoading(false);
  }
}

export async function showOrgRoot() {
  crumbs = [{ title: 'All Parks', mapId: state.orgRootMap.mapId, parkId: null }];
  await go(state.orgRootMap.mapId, null);
}

// Jump straight to a park (from the results list). Builds the full crumb
// trail: All Parks › Region › Park.
export async function showPark(parkId, mapId = null, focusResourceId = null) {
  const park = state.parksById.get(parkId);
  if (!park) return;
  const region = state.regionByParkId.get(parkId);
  crumbs = [{ title: 'All Parks', mapId: state.orgRootMap.mapId, parkId: null }];
  if (region) crumbs.push({ title: region.title, mapId: region.mapId, parkId: null });
  crumbs.push({ title: park.name, mapId: park.rootMapId, parkId });

  let target = mapId ?? park.rootMapId;
  if (mapId != null && mapId !== park.rootMapId) {
    const bundle = await getBundle(parkId).catch(() => null);
    const m = bundle?.maps.find((x) => x.mapId === mapId);
    crumbs.push({ title: m?.title || 'Campground', mapId, parkId });
  }
  await go(target, parkId, focusResourceId);
}

// Re-render the current view (used when scan results arrive so badges and
// site colours pick up fresh data).
export async function refreshCurrentView() {
  const cr = crumbs[crumbs.length - 1];
  if (cr) await go(cr.mapId, cr.parkId);
}

export const currentCrumb = () => crumbs[crumbs.length - 1] || null;
