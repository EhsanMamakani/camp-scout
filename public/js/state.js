// Shared app state. Deliberately simple: modules mutate it and call each
// other's render functions directly; no framework.

export const state = {
  parks: [],
  parksById: new Map(),
  rootMaps: [],
  orgRootMap: null,
  mapsById: new Map(),      // every trimmed map we have seen (org-level + bundles)
  bundles: new Map(),       // parkId -> {parkId, maps, resources} (resolved)
  bundlePromises: new Map(),
  regionByParkId: new Map(), // parkId -> region map (trimmed)
  attrDefs: new Map(),      // defId -> {name, order, values{enum:label}}
  iconLabels: {},           // site marker iconType -> label
  equipment: [],            // [{subEquipmentId, name}]

  criteria: null,           // {startDate,endDate,nights,dates[],subEquipmentId,partySize}

  scan: {
    running: false,
    handle: null,
    results: new Map(),     // parkId -> park event from the stream
    done: 0,
    total: 0,
    error: null,
  },

  // availability computed outside of scans (drill-down before/without a scan),
  // keyed by `${mapId}|${criteriaKey}` -> Map(resourceId -> boolean[] nights)
  mapAvailability: new Map(),
};

export const criteriaKey = (c) =>
  c ? `${c.startDate}|${c.endDate}|${c.subEquipmentId}|${c.partySize}` : 'none';

export function resetScan() {
  if (state.scan.handle) state.scan.handle.stop();
  state.scan = { running: false, handle: null, results: new Map(), done: 0, total: 0, error: null };
  state.mapAvailability.clear();
}
