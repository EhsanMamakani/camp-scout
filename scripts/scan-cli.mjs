// Command-line scan to JSON snapshot, via the local Camp Scout server
// (start it first: npm start).
//
//   node scripts/scan-cli.mjs 2026-07-31 2026-08-02 [subEquipmentId] [partySize] > snapshot.json
//
// subEquipmentId: -32768 Single Tent, -32767 2 Tents, -32766 3 Tents,
// -32765 RV<=18ft, -32764 <=25ft, -32763 <=32ft, -32762 >32ft

const [startDate, endDate, sub = '-32768', party = '1'] = process.argv.slice(2);
if (!startDate || !endDate) {
  console.error('usage: node scripts/scan-cli.mjs <startDate> <endDate(checkout)> [subEquipmentId] [partySize]');
  process.exit(1);
}

const base = process.env.SCOUT_URL || 'http://localhost:5177';
const q = new URLSearchParams({ startDate, endDate, subEquipmentId: sub, partySize: party });
const res = await fetch(`${base}/op/scan?${q}`, { headers: { Accept: 'text/event-stream' } });
if (!res.ok) {
  console.error(`server responded ${res.status}. Is it running? (npm start)`);
  process.exit(1);
}

const out = { generatedAt: new Date().toISOString(), startDate, endDate, parks: [] };
let meta = null;
let buffer = '';
const decoder = new TextDecoder();

for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let idx;
  while ((idx = buffer.indexOf('\n\n')) >= 0) {
    const frame = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
    if (!data) continue;
    const ev = JSON.parse(data);
    if (ev.type === 'start') {
      meta = ev;
      console.error(`scanning ${ev.total} parks for ${ev.dates.length} night(s)…`);
    } else if (ev.type === 'park') {
      if (ev.freeTotal > 0 || ev.partialTotal > 0) out.parks.push(ev);
      if (ev.freeTotal > 0) console.error(`  ${ev.name}: ${ev.freeTotal} whole-stay sites`);
    } else if (ev.type === 'progress') {
      if (ev.done % 25 === 0) console.error(`  …${ev.done}/${ev.total}`);
    } else if (ev.type === 'fatal') {
      console.error('scan failed:', ev.error);
      process.exit(1);
    }
  }
}

out.dates = meta?.dates || [];
out.options = meta?.opts || {};
out.parks.sort((a, b) => b.freeTotal - a.freeTotal);
console.log(JSON.stringify(out, null, 2));
console.error(`done: ${out.parks.reduce((s, p) => s + p.freeTotal, 0)} whole-stay sites in ${out.parks.filter((p) => p.freeTotal).length} parks`);
