import {describe,it,expect} from 'vitest';
import {Geometry} from '../src/ui/geometry';
import type {Topology} from '../src/sim/topology';

const length=(segments:ReturnType<Geometry['trainBody']>)=>segments.reduce((n,s)=>n+Math.hypot(s.x2-s.x1,s.y2-s.y1),0);
function geometry() {
  const g=Object.create(Geometry.prototype) as Geometry;
  Object.defineProperty(g,'topo',{value:{
    nodes:[{links:[0]},{links:[0,1,3]},{links:[1,2]},{links:[2]},{links:[3]}],
    links:[{a:0,b:1,len:1000,chainA:0,chainB:1000,section:0},{a:1,b:2,len:20,chainA:1000,chainB:1020,section:1},
      {a:2,b:3,len:500,chainA:1020,chainB:1520,section:2},{a:1,b:4,len:50,section:3}],berths:[],
  } as unknown as Topology});
  g.pos=[{row:0,x:0,y:0},{row:0,x:100,y:0},{row:0,x:120,y:20},{row:0,x:180,y:20},{row:0,x:80,y:-30}];
  return g;
}
describe('fixed screen train bodies',()=>{
  it('keeps its screen length when a schematic link represents different distances',()=>{
    const g=geometry();
    for(const meters of [100,1000]) {
      g.topo.links[0].len=meters;
      expect(length(g.trainBody({link:0,off:.8*meters,dir:1,body:[0,.6*meters,.8*meters],v:10,phase:'run'},22))).toBeCloseTo(22);
    }
  });
  it('follows the actual body over a bent switch without joining another rail',()=>{
    const g=geometry();
    const segments=g.trainBody({link:2,off:5,dir:1,body:[2,0,5,1,0,20,0,900,1000],v:10,phase:'run'},64);
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
    const tr={link:0,off:800,dir:1 as const,body:[0,200,800],v:0,phase:'stabled' as const};
    const segments=g.trainBody(tr,22);
    expect((segments[0].x1+segments[0].x2)/2).toBeCloseTo(50);
    expect(tr.off).toBe(800);
  });
});
