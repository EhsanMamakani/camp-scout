// Thin client for our local proxy server.

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `${r.status} ${url}`;
    try { msg = (await r.json()).error || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
  return r.json();
}

export const fetchParks = () => getJSON('/op/parks');
export const fetchRootMaps = () => getJSON('/op/maps/root');
export const fetchParkBundle = (parkId) => getJSON(`/op/park/${parkId}/bundle`);
export const fetchAttributes = () => getJSON('/op/attributes');
export const fetchEquipment = () => getJSON('/op/equipment');
export const fetchIconLabels = () => getJSON('/op/iconlabels');
export const fetchLegendIcons = (types) => getJSON('/op/legendicons?types=' + types.join(','));

export function fetchAvailability(mapId, criteria) {
  const q = new URLSearchParams({
    mapId,
    startDate: criteria.startDate,
    endDate: criteria.endDate,
    subEquipmentId: criteria.subEquipmentId,
    partySize: criteria.partySize,
  });
  return getJSON('/op/availability?' + q);
}

export const imgUrl = (upstreamUrl) => '/op/img?u=' + encodeURIComponent(upstreamUrl);

// Deep link into the real booking flow, pre-filled with the user's criteria.
export function bookingUrl({ parkId, mapId, criteria }) {
  const q = new URLSearchParams({
    mapId,
    searchTabGroupId: 0,
    bookingCategoryId: 0,
    resourceLocationId: parkId,
    equipmentId: -32768,
    subEquipmentId: criteria.subEquipmentId,
    startDate: criteria.startDate,
    endDate: criteria.endDate,
    nights: criteria.nights,
    isReserving: true,
    partySize: criteria.partySize,
  });
  return 'https://reservations.ontarioparks.ca/create-booking/results?' + q;
}

// Server-Sent Events scan; calls onEvent for every parsed message.
// Returns a handle with stop().
export function startScan(criteria, onEvent) {
  const q = new URLSearchParams({
    startDate: criteria.startDate,
    endDate: criteria.endDate,
    subEquipmentId: criteria.subEquipmentId,
    partySize: criteria.partySize,
  });
  const es = new EventSource('/op/scan?' + q);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'done' || ev.type === 'fatal') es.close();
    onEvent(ev);
  };
  es.onerror = () => {
    es.close();
    onEvent({ type: 'fatal', error: 'scan stream interrupted' });
  };
  return { stop: () => es.close() };
}
