import {describe,it,expect} from 'vitest';
import {Geometry} from '../src/ui/geometry';
import type {Topology} from '../src/sim/topology';

const length=(segments:ReturnType<Geometry['trainBody']>)=>segments.reduce((n,s)=>n+Math.hypot(s.x2-s.x1,s.y2-s.y1),0);
const N=()=>'N' as const;
function geometry() {
  const g=Object.create(Geometry.prototype) as Geometry;
  Object.defineProperty(g,'topo',{value:{
    nodes:[{links:[0]},{links:[0,1,3]},{links:[1,2]},{links:[2]},{links:[3]}],
    links:[{a:0,b:1,len:1000,chainA:0,chainB:1000,section:0},{a:1,b:2,len:20,chainA:1000,chainB:1020,section:1},
      {a:2,b:3,len:500,chainA:1020,chainB:1520,section:2},{a:1,b:4,len:50,section:3}],berths:[],platforms:[],
  } as unknown as Topology});
  g.pos=[{row:0,x:0,y:0},{row:0,x:100,y:0},{row:0,x:120,y:20},{row:0,x:180,y:20},{row:0,x:80,y:-30}];
  return g;
}
describe('fixed length train symbols',()=>{
  it('keeps its screen length when a schematic link represents different distances',()=>{
    const g=geometry();
    for(const meters of [100,1000]) {
      g.topo.links[0].len=meters;
      expect(length(g.trainBody({link:0,off:.8*meters,dir:1,body:[0,.6*meters,.8*meters],v:10},22,N))).toBeCloseTo(22);
    }
  });
  it('follows the actual body over a bent switch without joining another rail',()=>{
    const g=geometry();
    const segments=g.trainBody({link:2,off:5,dir:1,body:[2,0,5,1,0,20,0,900,1000],v:10},64,N);
    expect(length(segments)).toBeCloseTo(64);
    expect(segments).toHaveLength(3);
    for(let i=1;i<segments.length;i++) {
      expect(segments[i].x1).toBeCloseTo(segments[i-1].x2);
      expect(segments[i].y1).toBeCloseTo(segments[i-1].y2);
    }
    expect(segments.every(s=>s.y1>=0&&s.y2>=0)).toBe(true);
  });
  it('centres the parked symbol on the physical footprint without changing the head',()=>{
    const g=geometry();
    g.topo.berths.push({link:0,offset:800} as Topology['berths'][number]);
    const tr={link:0,off:800,dir:1 as const,body:[0,200,800],v:0};
    const segments=g.trainBody(tr,22,N);
    expect((segments[0].x1+segments[0].x2)/2).toBeCloseTo(50);
    expect(tr.off).toBe(800);
  });
  it('keeps a train stopped at a platform anchored at its head',()=>{
    const g=geometry();
    g.topo.berths.push({link:0,offset:800,kind:'platform'} as Topology['berths'][number]);
    const segments=g.trainBody({link:0,off:800,dir:1,body:[0,200,800],v:0},22,N);
    expect(segments[0].x1).toBeCloseTo(80);
  });
  it('continues behind the physical tail over the switch leg it lies in and reports the sections',()=>{
    const g=geometry();
    Object.assign(g.topo.nodes[1],{kind:'switch',sw:0,toe:0,normal:1,reverse:3});
    const tr={link:0,off:950,dir:-1 as const,body:[0,950,1000],v:10};
    const normal=g.trainBody(tr,30,N);
    expect(length(normal)).toBeCloseTo(30);
    expect([...new Set(normal.map(s=>s.section))]).toEqual([0,1]);
    const reverse=g.trainBody(tr,30,()=>'R');
    expect([...new Set(reverse.map(s=>s.section))]).toEqual([0,3]);
    // from a leg the toe is the only way back, whatever the switch lies in
    const fromLeg=g.trainBody({link:1,off:20,dir:1,body:[1,0,20],v:10},40,()=>'R');
    expect([...new Set(fromLeg.map(s=>s.section))]).toEqual([1,0]);
  });
});
