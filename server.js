// Camp Scout server: proxy, cache and availability scanner for reservations.ontarioparks.ca
//
// The upstream API sits behind an Azure WAF that rejects non-browser clients,
// and it sends no CORS headers, so the browser UI can never call it directly.
// Everything goes through here with browser-like headers, a global concurrency
// cap, disk caching for stable metadata and a short in-memory cache for
// availability responses.

import express from 'express';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5177;

const BASE = 'https://reservations.ontarioparks.ca';
const UPSTREAM_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-CA,en;q=0.9',
  Referer: BASE + '/create-booking/results',
};

const CACHE_DIR = path.join(__dirname, 'data', 'cache');
const IMG_DIR = path.join(__dirname, 'data', 'img');
mkdirSync(CACHE_DIR, { recursive: true });
mkdirSync(IMG_DIR, { recursive: true });

const DAY = 24 * 60 * 60 * 1000;
const STATIC_TTL = 12 * 60 * 60 * 1000; // parks / maps / resources
const ICON_TTL = 7 * DAY; // legend icons, attribute defs, equipment
const AVAIL_TTL = 3 * 60 * 1000; // availability (memory only)

const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const en = (lv) => (lv || []).find((v) => v.cultureName === 'en-CA') || (lv || [])[0] || {};
const toArray = (x) => (Array.isArray(x) ? x : Object.values(x || {}));

// ---------------------------------------------------------------- upstream

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}
const limit = createLimiter(6);

async function upstreamJson(pathname) {
  return limit(async () => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(BASE + pathname, { headers: UPSTREAM_HEADERS });
        if (r.ok) {
          const text = await r.text();
          try {
            return JSON.parse(text);
          } catch {
            throw new Error(`non-JSON response (WAF challenge?) for ${pathname}`);
          }
        }
        lastErr = new Error(`upstream ${r.status} for ${pathname}`);
        if (![403, 408, 429, 500, 502, 503, 504].includes(r.status)) throw lastErr;
      } catch (e) {
        lastErr = e;
      }
      await sleep(600 * (attempt + 1) * (attempt + 1));
    }
    throw lastErr;
  });
}

async function diskCached(key, ttlMs, loader) {
  const file = path.join(CACHE_DIR, sha1(key) + '.json');
  try {
    const { ts, data } = JSON.parse(await readFile(file, 'utf8'));
    if (Date.now() - ts < ttlMs) return data;
  } catch { /* miss */ }
  const data = await loader();
  await writeFile(file, JSON.stringify({ ts: Date.now(), key, data }));
  return data;
}

const memCache = new Map();
function memCached(key, ttlMs, loader) {
  const hit = memCache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.promise;
  const promise = loader().catch((e) => {
    memCache.delete(key);
    throw e;
  });
  memCache.set(key, { ts: Date.now(), promise });
  if (memCache.size > 3000) {
    const cutoff = Date.now() - ttlMs;
    for (const [k, v] of memCache) if (v.ts < cutoff) memCache.delete(k);
  }
  return promise;
}

// ---------------------------------------------------------------- shaping

// gpsCoordinates comes in two formats: "48.17, -90.22" and
// "Latitude: 49.69, Longitude: -86.90"; only a handful of parks have it.
function parseGps(s) {
  const nums = String(s || '').match(/-?\d+\.\d+/g);
  if (!nums || nums.length < 2) return null;
  const lat = parseFloat(nums[0]);
  const lng = parseFloat(nums[1]);
  if (lat < 41 || lat > 57 || lng < -96 || lng > -73) return null; // not in Ontario
  return { lat, lng };
}

function trimPark(p) {
  const v = en(p.localizedValues);
  // physical address (the ontarioparks.ca "Physical Address"), present for
  // 125 of 127 parks; regionCode holds the postal code
  const street = (v.streetAddress || '').trim();
  const city = (v.city || '').trim();
  const postal = /^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/.test((p.regionCode || '').trim())
    ? p.regionCode.trim().toUpperCase()
    : '';
  const address = street && city
    ? `${street}, ${city}, ON${postal ? ' ' + postal : ''}`
    : null;
  return {
    parkId: p.resourceLocationId,
    rootMapId: p.rootMapId,
    name: v.fullName || v.shortName || String(p.resourceLocationId),
    description: v.description || '',
    website: v.website || '',
    phone: p.phoneNumber || '',
    photo: p.photos?.[0]?.photoUrlResult?.url || null,
    gps: parseGps(p.gpsCoordinates),
    drivingDirections: v.drivingDirections || '',
    address,
  };
}

function trimMap(m) {
  return {
    mapId: m.mapId,
    parentMapId: m.parentMap?.mapId ?? null,
    parkId: m.parentMap?.resourceLocationId ?? m.resourceLocationId ?? null,
    title: en(m.localizedValues).title || '',
    imageUrl: m.mapImageUrls?.['en-CA'] || Object.values(m.mapImageUrls || {})[0] || null,
    w: m.xDimension,
    h: m.yDimension,
    isOrgRoot: !!m.isOrganizationRoot,
    links: (m.mapLinks || []).map((l) => ({
      childMapId: l.childMapId,
      parkId: l.resourceLocationId ?? null,
      title: en(l.localizations).title || '',
      point: l.localizationPoint
        ? { x: l.localizationPoint.xCoordinate, y: l.localizationPoint.yCoordinate }
        : null,
      area: (l.areaPoints || [])
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((p) => [p.xCoordinate, p.yCoordinate]),
    })),
    resources: (m.mapResources || []).map((r) => ({
      resourceId: r.resourceId,
      iconType: r.iconType,
      x: r.xCoordinate,
      y: r.yCoordinate,
      // where the official map draws the site-number label
      labelPoint: r.localizationPoint
        ? { x: r.localizationPoint.xCoordinate, y: r.localizationPoint.yCoordinate,
            rgb: [r.localizationPoint.rValue || 0, r.localizationPoint.gValue || 0, r.localizationPoint.bValue || 0] }
        : null,
    })),
    // legendItemType = glyph id (for /api/maps/legendicons); iconType = tile
    // shape (usually 17 = rounded square); rgb = tile colour.
    legends: (m.mapLegendItems || []).map((li) => ({
      type: li.legendItemType,
      shape: li.iconType,
      rgb: [li.rValue || 0, li.gValue || 0, li.bValue || 0],
      x: li.xCoordinate,
      y: li.yCoordinate,
    })),
    labels: (m.mapLabels || []).map((la) => ({
      text: en(la.localizedValues).label || '',
      x: la.localizationPoint?.xCoordinate ?? 0,
      y: la.localizationPoint?.yCoordinate ?? 0,
      fontSize: la.fontSize || 12,
      bold: !!la.isBold,
      italic: !!la.isItalics,
      rgb: [la.rValue || 0, la.gValue || 0, la.bValue || 0],
    })),
  };
}

function trimResource(r) {
  const v = en(r.localizedValues);
  return {
    resourceId: r.resourceId,
    name: v.name || String(r.resourceId),
    description: v.description || '',
    minCapacity: r.minCapacity,
    maxCapacity: r.maxCapacity,
    maxStay: r.maxStay,
    allowedEquipment: (r.allowedEquipment || []).map((e2) => e2.subEquipmentCategoryId),
    attributes: (r.definedAttributes || []).map((a) => ({
      defId: a.attributeDefinitionId,
      value: a.value,
      values: a.values || [],
    })),
    photos: (r.photos || [])
      .map((p) => p.photoUrlResult?.url)
      .filter(Boolean),
    mapIds: r.mapIds || [],
  };
}

// ---------------------------------------------------------------- loaders

const getParksRaw = () => diskCached('parks', STATIC_TTL, () => upstreamJson('/api/resourceLocation'));
const getRootMapsRaw = () => diskCached('maps-root', STATIC_TTL, () => upstreamJson('/api/maps/root'));
const getParkMapsRaw = (parkId) =>
  diskCached('maps:' + parkId, STATIC_TTL, () => upstreamJson('/api/maps?resourceLocationId=' + parkId));
const getParkResourcesRaw = (parkId) =>
  diskCached('resources:' + parkId, STATIC_TTL, () =>
    upstreamJson('/api/resourcelocation/resources?resourceLocationId=' + parkId));

async function getParks() {
  const raw = await getParksRaw();
  return raw.filter((p) => p.rootMapId != null).map(trimPark);
}

async function getParkBundle(parkId) {
  const [mapsRaw, resourcesRaw] = await Promise.all([
    getParkMapsRaw(parkId),
    getParkResourcesRaw(parkId),
  ]);
  const resources = {};
  for (const r of toArray(resourcesRaw)) resources[r.resourceId] = trimResource(r);
  return { parkId: Number(parkId), maps: toArray(mapsRaw).map(trimMap), resources };
}

function availabilityPath(mapId, opts) {
  const q = new URLSearchParams({
    mapId,
    bookingCategoryId: 0,
    equipmentCategoryId: -32768,
    subEquipmentCategoryId: opts.subEquipmentId,
    startDate: opts.startDate,
    endDate: opts.endDate,
    getDailyAvailability: 'true',
    isReserving: 'false',
    filterData: '[]',
    boatLength: 0,
    boatDraft: 0,
    boatWidth: 0,
    numEquipment: 0,
    peopleCapacityCategoryCounts: JSON.stringify([
      { capacityCategoryId: -32768, subCapacityCategoryId: null, count: opts.partySize, isAdult: null },
    ]),
    seed: new Date().toISOString(),
  });
  return '/api/availability/map?' + q;
}

function getAvailability(mapId, opts) {
  const key = `avail:${mapId}:${opts.startDate}:${opts.endDate}:${opts.subEquipmentId}:${opts.partySize}`;
  return memCached(key, AVAIL_TTL, () => upstreamJson(availabilityPath(mapId, opts)));
}

// ---------------------------------------------------------------- scan

function parseScanOpts(query) {
  const startDate = String(query.startDate || '');
  const endDate = String(query.endDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error('startDate and endDate must be YYYY-MM-DD');
  }
  const nights = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 864e5);
  if (!(nights >= 1 && nights <= 30)) throw new Error('stay must be 1-30 nights (endDate is checkout)');
  const subEquipmentId = parseInt(query.subEquipmentId, 10) || -32768;
  const partySize = Math.min(Math.max(parseInt(query.partySize, 10) || 1, 1), 100);
  return { startDate, endDate, nights, subEquipmentId, partySize };
}

const hasFreeRun = (arr, n) =>
  Array.isArray(arr) && arr.length >= n && arr.slice(0, n).every((x) => x && x.availability === 0);

async function scanPark(park, opts) {
  const root = await getAvailability(park.rootMapId, opts);
  const n = opts.nights;

  // Cheap pre-filter. A single site must be free every night, so a park only
  // qualifies if some site directly on the root map has a full free run, or
  // some child map shows availability on every requested night (necessary,
  // not sufficient; pass 2 below gives the per-site truth).
  const directHit = Object.values(root.resourceAvailabilities || {}).some((a) => hasFreeRun(a, n));
  const childHit = Object.values(root.mapLinkAvailabilities || {}).some(
    (a) => Array.isArray(a) && a.length >= n && a.slice(0, n).every((v) => v === 0),
  );
  if (!directHit && !childHit) {
    return { parkId: park.parkId, name: park.name, freeTotal: 0, partialTotal: 0, campgrounds: [] };
  }

  const bundle = await getParkBundle(park.parkId);
  const campgrounds = [];
  for (const m of bundle.maps) {
    if (!m.resources.length) continue;
    let av;
    try {
      av = await getAvailability(m.mapId, opts);
    } catch {
      continue;
    }
    const sites = [];
    for (const mr of m.resources) {
      const arr = av.resourceAvailabilities?.[mr.resourceId];
      if (!arr) continue;
      const nightsFree = arr.slice(0, n).map((x) => x && x.availability === 0);
      if (!nightsFree.some(Boolean)) continue;
      const meta = bundle.resources[mr.resourceId] || {};
      sites.push({
        resourceId: mr.resourceId,
        name: meta.name || String(mr.resourceId),
        fullStay: nightsFree.length >= n && nightsFree.every(Boolean),
        nights: nightsFree,
      });
    }
    if (sites.length) {
      sites.sort((a, b) => Number(b.fullStay) - Number(a.fullStay) || a.name.localeCompare(b.name, 'en', { numeric: true }));
      campgrounds.push({
        mapId: m.mapId,
        title: m.title,
        free: sites.filter((s) => s.fullStay).length,
        partial: sites.filter((s) => !s.fullStay).length,
        sites,
      });
    }
  }
  campgrounds.sort((a, b) => b.free - a.free);
  return {
    parkId: park.parkId,
    name: park.name,
    freeTotal: campgrounds.reduce((s, c) => s + c.free, 0),
    partialTotal: campgrounds.reduce((s, c) => s + c.partial, 0),
    campgrounds,
  };
}

// ---------------------------------------------------------------- app

const app = express();
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));
app.use(express.static(path.join(__dirname, 'public')));

const asyncRoute = (fn) => (req, res) => {
  fn(req, res).catch((e) => {
    console.error(req.path, e.message);
    res.status(502).json({ error: e.message });
  });
};

app.get('/op/parks', asyncRoute(async (_req, res) => {
  res.json(await getParks());
}));

app.get('/op/maps/root', asyncRoute(async (_req, res) => {
  const raw = await getRootMapsRaw();
  res.json(raw.map(trimMap));
}));

app.get('/op/park/:parkId/bundle', asyncRoute(async (req, res) => {
  res.json(await getParkBundle(parseInt(req.params.parkId, 10)));
}));

app.get('/op/attributes', asyncRoute(async (_req, res) => {
  const raw = await diskCached('attributes', ICON_TTL, () => upstreamJson('/api/attribute/filterable'));
  res.json(
    toArray(raw).map((a) => ({
      defId: a.attributeDefinitionId,
      name: en(a.localizedValues).displayName || '',
      order: a.order,
      values: Object.fromEntries(
        (a.values || []).map((v) => [v.enumValue, en(v.localizedValues).displayName || String(v.enumValue)]),
      ),
    })),
  );
}));

app.get('/op/equipment', asyncRoute(async (_req, res) => {
  const raw = await diskCached('equipment', ICON_TTL, () => upstreamJson('/api/equipment'));
  const cats = toArray(raw).flatMap((c) =>
    (c.subEquipmentCategories || []).map((s) => ({
      subEquipmentId: s.subEquipmentCategoryId,
      name: en(s.localizedValues).name || '',
    })),
  );
  res.json(cats);
}));

app.get('/op/iconlabels', asyncRoute(async (_req, res) => {
  const raw = await diskCached('iconlabels', ICON_TTL, () => upstreamJson('/api/mapLegendResourceIconLabel'));
  res.json(Object.fromEntries(toArray(raw).map((i) => [i.mapIconType, en(i.localizedValues).name || ''])));
}));

// The official UI translates legend icon localizationKeys through its locale
// bundle (assets/locales/map-view.component.en-CA.json, ICON key, ~800 entries).
const getIconLabelDict = () =>
  diskCached('icon-label-dict', ICON_TTL, async () => {
    const loc = await upstreamJson('/assets/locales/map-view.component.en-CA.json');
    return loc.ICON || {};
  });

app.get('/op/legendicons', asyncRoute(async (req, res) => {
  const types = String(req.query.types || '')
    .split(',')
    .map((t) => parseInt(t, 10))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (!types.length) return res.json([]);
  const [data, dict] = await Promise.all([
    diskCached('legendicons:' + types.join(','), ICON_TTL, () =>
      upstreamJson('/api/maps/legendicons?mapLegendTypes=' + encodeURIComponent(JSON.stringify(types)))),
    getIconLabelDict(),
  ]);
  res.json(
    toArray(data).map((i) => ({
      type: i.legendItemType,
      key: i.localizationKey,
      label: dict[i.localizationKey] || i.localizationKey || '',
      dataUri: i.encodedImage ? 'data:image/png;base64,' + i.encodedImage : null,
    })),
  );
}));

app.get('/op/availability', asyncRoute(async (req, res) => {
  const opts = parseScanOpts(req.query);
  const mapId = parseInt(req.query.mapId, 10);
  if (!Number.isFinite(mapId)) throw new Error('mapId required');
  res.json(await getAvailability(mapId, opts));
}));

// Per-site future availability, one boolean per day from startDate.
// Backs the popup's "Site calendar" (same endpoint the official button uses).
app.get('/op/sitecalendar', asyncRoute(async (req, res) => {
  const resourceId = parseInt(req.query.resourceId, 10);
  if (!Number.isFinite(resourceId)) throw new Error('resourceId required');
  const startDate = String(req.query.startDate || '');
  const endDate = String(req.query.endDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error('startDate and endDate must be YYYY-MM-DD');
  }
  const days = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 864e5);
  if (!(days >= 1 && days <= 240)) throw new Error('range must be 1-240 days');
  const key = `sitecal:${resourceId}:${startDate}:${endDate}`;
  const data = await memCached(key, AVAIL_TTL * 3, () =>
    upstreamJson(`/api/availability/resourcedailyavailability?resourceId=${resourceId}`
      + `&startDate=${startDate}&endDate=${endDate}&seed=${new Date().toISOString()}`));
  res.json({ resourceId, startDate, days: toArray(data).map((d) => d && d.availability === 0) });
}));

// Image proxy (map PNGs + site photos live behind the same WAF).
app.get('/op/img', asyncRoute(async (req, res) => {
  const u = String(req.query.u || '');
  let url;
  try {
    url = new URL(u);
  } catch {
    return res.status(400).json({ error: 'bad url' });
  }
  if (url.origin !== BASE) return res.status(400).json({ error: 'only reservations.ontarioparks.ca images' });
  const ext = (url.pathname.match(/\.(png|jpg|jpeg|gif|webp|avif)$/i) || [, 'png'])[1].toLowerCase();
  const file = path.join(IMG_DIR, sha1(u) + '.' + ext);
  const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' }[ext];
  try {
    const buf = await readFile(file);
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.end(buf);
  } catch { /* miss */ }
  const buf = Buffer.from(
    await limit(async () => {
      const r = await fetch(u, { headers: { ...UPSTREAM_HEADERS, Accept: 'image/*' } });
      if (!r.ok) throw new Error(`image ${r.status}`);
      return r.arrayBuffer();
    }),
  );
  await writeFile(file, buf);
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(buf);
}));

// Province-wide scan, streamed as Server-Sent Events so results appear live.
app.get('/op/scan', async (req, res) => {
  let opts;
  try {
    opts = parseScanOpts(req.query);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    let parks = await getParks();
    const only = String(req.query.parkIds || '')
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter(Number.isFinite);
    if (only.length) parks = parks.filter((p) => only.includes(p.parkId));

    const dates = Array.from({ length: opts.nights }, (_, i) =>
      new Date(Date.parse(opts.startDate) + i * 864e5).toISOString().slice(0, 10));
    console.log(`scan start: ${opts.startDate} to ${opts.endDate} equip=${opts.subEquipmentId} party=${opts.partySize} parks=${parks.length}`);
    send({ type: 'start', total: parks.length, dates, opts });

    let done = 0;
    const t0 = Date.now();
    const queue = parks.slice();
    const workers = Array.from({ length: 5 }, async () => {
      while (queue.length && !aborted) {
        const park = queue.shift();
        try {
          const result = await scanPark(park, opts);
          if (aborted) return;
          send({ type: 'park', ...result });
        } catch (e) {
          if (!aborted) send({ type: 'park', parkId: park.parkId, name: park.name, error: e.message, freeTotal: 0, partialTotal: 0, campgrounds: [] });
        }
        done++;
        send({ type: 'progress', done, total: parks.length });
      }
    });
    await Promise.all(workers);
    if (!aborted) {
      send({ type: 'done', elapsedMs: Date.now() - t0 });
      res.end();
    }
  } catch (e) {
    if (!aborted) {
      send({ type: 'fatal', error: e.message });
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Camp Scout running at http://localhost:${PORT}`);
});
