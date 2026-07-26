# Camp Scout: Ontario Parks availability finder

**Just want to use it? It's live at [camp-scout-2gck.onrender.com](https://camp-scout-2gck.onrender.com/)** (free hosting, so give it up to a minute to wake if it's been idle).

Scan **every Ontario Provincial Park at once** for campsites that are free for
*all* the nights of your stay, then explore them on the same maps the official
reservation site uses: park by park, campground by campground, site by site,
with each site's amenities, photos and a one-click deep link into the real
booking flow.

## Run it

```bash
npm install
npm start          # then open http://localhost:5177
```

Pick arrive/depart dates, your equipment (tent vs trailer sizes, which changes
results a lot), party size, and hit **Scan all parks**. Results stream in live;
click any park/campground/site to jump to it on the map.

## Why this exists

The official site can only search one park at a time, and its park-level
availability roll-ups are misleading: a park can show "available" on every
night of your stay while **no single site** is free for all of them (different
sites free on different nights). This tool always checks per-site,
per-night data (`resourceAvailabilities`) and only counts a site when every
night of your stay is open on that same site. Roll-ups are used only as a
cheap pre-filter to skip fully-booked parks.

## How it works

- `server.js`: Express server that
  - proxies the JSON API at `reservations.ontarioparks.ca` (it sits behind an
    Azure WAF that rejects non-browser clients, and has no CORS headers, so
    the browser can't call it directly);
  - disk-caches stable metadata (parks, maps, resources, attributes, icons)
    in `data/` for 12h and availability in memory for 3 min;
  - keeps a global cap of 6 concurrent upstream requests;
  - streams province-wide scans over Server-Sent Events (`/op/scan`).
- `public/`: vanilla JS + Leaflet UI. The maps are the official site's own
  map images (province, region, park, campground), rendered with
  `L.CRS.Simple` image overlays. Site markers use the official per-type
  shapes and availability colours; clickable region/campground polygons,
  text labels, amenity icons and the three-section legend all come from the
  same map API the official UI uses.

## Upstream API notes (hard-won)

- `availability === 0` means available; anything else (1, 6, ...) is not
  bookable. `startDate` is the first night, `endDate` the checkout day.
- Equipment codes: category `-32768`, subs: `-32768` Single Tent, `-32767`
  2 Tents, `-32766` 3 Tents, `-32765` RV up to 18ft, `-32764` up to 25ft,
  `-32763` up to 32ft, `-32762` over 32ft.
- `/api/resourcelocation/resources` returns a **keyed object**, `/api/maps`
  returns an **array**; both are normalized server-side.
- Site amenities come from `definedAttributes` on each resource, decoded
  against `/api/attribute/filterable` (55 definitions with enum labels).
- Site marker labels: `/api/mapLegendResourceIconLabel`. On map legend items,
  `legendItemType` is the amenity glyph id (fetch the white-on-transparent
  PNG via `/api/maps/legendicons?mapLegendTypes=[...]`) while `iconType` is
  the coloured tile shape drawn behind it.
- Amenity display names live in the locale bundle at
  `/assets/locales/map-view.component.en-CA.json` under `ICON`.

## CLI snapshot

With the server running:

```bash
node scripts/scan-cli.mjs 2026-07-31 2026-08-02 -32768 2 > snapshot.json
```

Unofficial hobby tool. All data © Ontario Parks; be polite to their API
(the server already caps concurrency and caches aggressively). Book through
[reservations.ontarioparks.ca](https://reservations.ontarioparks.ca).
