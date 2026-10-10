import { buildTopology } from '../src/sim/topology';
const t = buildTopology();
console.log('nodes', t.nodes.length, 'links', t.links.length, 'switches', t.switches.length, 'sections', t.sections.length,
  'signals', t.signals.length, 'routes', t.routes.length, 'berths', t.berths.length, 'fleeting', t.routes.filter(r => r.fleeting).length);
for (const s of t.stations) console.log(s.index, s.name, s.chain, 'row', s.row, 'x', s.x.toFixed(0), 'eq', s.equipped, 'tb', s.turnbackBerths.map(b => t.berths[b].name).join(','), JSON.stringify(s.frontTurnback));
const bad = t.links.filter(l => l.section < 0);
console.log('links without section', bad.length);
console.log('signals sample', t.signals.slice(0, 12).map(s => `${s.name}:${s.role}@${s.chain.toFixed(0)}`).join(' '));
console.log('switches', t.switches.map(s => s.name).join(' '));
const noRoute = t.signals.filter(s => s.routes.length === 0);
console.log('signals without routes', noRoute.map(s => s.name + ':' + s.role).join(' '));
