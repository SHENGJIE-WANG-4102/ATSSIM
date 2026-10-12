import {describe,it,expect} from 'vitest';
import {Sim} from '../src/sim/engine';
import {platformBerth,dayPeriods} from '../src/sim/timetable';
import {updateTrainTasks} from '../src/sim/ats';
import {releaseRoute} from '../src/sim/interlocking';
import {computeBody,indexBodies} from '../src/sim/movement';
import {classify} from '../src/sim/halt';
import {computeDmi} from '../src/sim/dmi';

const advance=(s:Sim,t:number)=>{const end=s.t+t;while(s.t<end-1e-6)s.step();};
function fixture(station:number,delay:number,dwell:number,waiting=0,load=0){
 const s=new Sim({dayType:'weekday',dateLabel:'calibration',startTime:14400,seed:7,noPossessions:true});advance(s,2);const tr=s.trainList[0];
 for(const other of [...s.trainList])if(other!==tr)s.removeTrain(other);
 for(const id of [...s.routes.keys()])releaseRoute(s,id);
 for(const b of s.plan.blocks)s.blockDone.add(b.id);
 // A controlled passenger arrival scenario: all new demand is disabled while
 // the specified platform queues use the real boarding and door code.
 for(const t of s.plan.trips)t.cancelled=true;s.planRev++;s.t=8*3600;
 for(const p of s.plat)p.waiting=0;
 const berth=s.topo.berths[platformBerth(s.topo,station,'DN')];
 tr.link=berth.link;tr.off=berth.offset;tr.dir=1;tr.hist=[{link:berth.link,dir:1}];tr.v=0;tr.eb=false;tr.phase='run';tr.block=-1;tr.tripId=-1;tr.inService=true;tr.load=load;tr.tbStage='none';tr.depotStage='none';
 const arr=s.t-delay;let dep=arr+dwell;
 tr.tasks=[{k:'stop',berth:berth.id,station,trip:-1,arr,dep,doors:true,revenue:true}];
 for(let st=station+1;st<=Math.min(22,station+5);st++){
  const arrival=dep+s.rt.dn[st-1];dep=arrival+25;
  tr.tasks.push({k:'stop',berth:platformBerth(s.topo,st,'DN'),station:st,trip:-1,arr:arrival,dep,doors:true,revenue:true});
 }
 tr.maDist=tr.maFar=0;tr.maSigs=[];tr.lastMa=Infinity;tr.stopDist=0;tr.lastDs=0;
 computeBody(s,tr);indexBodies(s);s.plat[berth.platform].waiting=waiting;updateTrainTasks(s,tr);
 return {s,tr,p:berth.platform};
}
describe('automatic dwell and ATO regulation',()=>{
 it('recovers seven seconds at an ordinary station and closes before countdown zero',()=>{
  const {s,tr}=fixture(5,7,25,40,100);const arrived=s.t;
  expect(tr.dwellUntil-arrived).toBeCloseTo(18,1);expect(computeDmi(s,tr.id)?.dwellTotal).toBeCloseTo(18,1);
  advance(s,13.5);expect(tr.doorsOpen).toBe(false);expect(tr.phase).toBe('dwell');expect(tr.dwellUntil-s.t).toBeGreaterThan(0);
  advance(s,4.8);expect(tr.phase).toBe('run');expect(Math.abs(tr.delay)).toBeLessThan(.3);expect(tr.v).toBeGreaterThan(0);
  expect(s.integrity.violations).toHaveLength(0);
 });
 it('records DEP at wheel start after a dispatcher hold, rather than at door closure',()=>{
  const {s,tr}=fixture(5,0,25);const task=tr.tasks[0];if(task.k!=='stop')throw new Error('fixture stop');task.trip=0;
  while(tr.phase==='dwell')s.step();tr.hold=true;expect(tr.pendingDeparture).toBeDefined();expect(s.depLog).toHaveLength(0);
  advance(s,5);expect(tr.v).toBe(0);expect(s.depLog).toHaveLength(0);
  tr.hold=false;advance(s,.2);expect(tr.v).toBeGreaterThan(0);expect(s.depLog).toHaveLength(1);
  expect(s.depLog[0].delay).toBeGreaterThanOrEqual(5);
 });
 it('keeps the peak passenger minimum and recovers at following stops',()=>{
  const {s,tr}=fixture(12,7,30,1300,1900);const minimum=tr.dwellUntil-s.t;
  expect(minimum).toBeGreaterThan(30);advance(s,minimum+.2);expect(tr.delay).toBeGreaterThan(7);
  const atDeparture=tr.delay;
  let departures=0,phase=tr.phase;const until=s.t+1000;
  while(s.t<until&&departures<3){s.step();if(phase==='dwell'&&tr.phase==='run')departures++;phase=tr.phase;}
  expect(departures).toBe(3);expect(tr.delay).toBeLessThan(atDeparture);expect(Math.abs(tr.delay)).toBeLessThan(1);
  expect(s.integrity.violations).toHaveLength(0);
 });
 it('does not give 047-2006 a long LAYOVER at 世纪大道 while seven seconds early',()=>{
  const {s,tr}=fixture(16,-7,25,80,500);tr.svc='047';tr.tripNo='2006';
  expect(tr.dwellUntil-s.t).toBeCloseTo(32,1);expect(classify(s,tr).code).toBe('DWELL');
  advance(s,32.2);expect(tr.phase).toBe('run');expect(Math.abs(tr.delay)).toBeLessThan(.3);
 });
 it('caps early platform regulation at ten seconds and keeps ATP speed supervision',()=>{
  const {s,tr}=fixture(5,-60,25,0,0);expect(tr.dwellUntil-s.t).toBeCloseTo(35,1);
  advance(s,35.3);expect(tr.delay).toBeLessThan(-49);advance(s,20);
  expect(tr.vTarget).toBeLessThanOrEqual(tr.vPermit);expect(tr.v).toBeLessThanOrEqual(tr.vPermit+.15);expect(tr.eb).toBe(false);
 });
});
describe('calibrated plan structure',()=>{
 it.each(['weekday','weekend'] as const)('%s dwells never exceed thirty seconds',dayType=>{
  const s=new Sim({dayType,dateLabel:'calibration',startTime:14400,seed:1});
  for(const t of s.plan.trips.filter(t=>t.revenue&&!t.cancelled))for(const p of t.stops)expect(p.dep-p.arr).toBeLessThanOrEqual(30+.001);
 });
 it('has the peak wave throughout the core at both band edges, including 北新泾 UP',()=>{
  const s=new Sim({dayType:'weekday',dateLabel:'calibration',startTime:14400,seed:1});
  const peaks=dayPeriods('weekday').filter(p=>p.template==='weekdayAM'||p.template==='weekdayPM');
  for(const peak of peaks)for(const dir of ['DN','UP'] as const)for(let st=4;st<=22;st++){
   const ref=dir==='DN'?4:22, end=dir==='DN'?22:4;
   const times=s.plan.trips.filter(t=>t.revenue&&!t.cancelled&&t.dir===dir&&['big','small'].includes(t.kind))
    .flatMap(t=>t.stops.filter(p=>p.st===st).map(p=>st===end?p.arr:p.dep)).sort((a,b)=>a-b);
   for(const edge of [peak.from,peak.to]){
    const at=times.findIndex(t=>t>=edge);
    expect(at,`${dir} station ${st}, ${edge}`).toBeGreaterThan(0);
    expect(times[at]-times[at-1],`${dir} station ${st}, ${edge}`).toBeGreaterThan(145);
    expect(times[at]-times[at-1],`${dir} station ${st}, ${edge}`).toBeLessThan(155);
   }
   if(st===ref){const transition=times.filter(t=>t<peak.from-2400&&t>peak.from-4200);
    const gaps=transition.slice(1).map((t,i)=>t-transition[i]);
    expect(gaps.length).toBeGreaterThan(3);expect(gaps.at(-1)!).toBeLessThan(gaps[0]);}
  }
 });
 it('has uniform peak core slots and alternating outer big-route intervals',()=>{
  const s=new Sim({dayType:'weekday',dateLabel:'calibration',startTime:14400,seed:1});
  for(const dir of ['DN','UP'] as const){const ref=dir==='DN'?4:22;
   const p=dayPeriods('weekday').find(p=>p.template==='weekdayAM')!;
   const core=s.plan.trips.filter(t=>['big','small'].includes(t.kind)&&t.dir===dir).map(t=>({t,dep:t.stops.find(x=>x.st===ref)!.dep})).filter(x=>x.dep>=p.from+.01&&x.dep<p.to-.01).sort((a,b)=>a.dep-b.dep);
   expect(core.length).toBeGreaterThan(40);
   for(let i=1;i<core.length;i++)expect(core[i].dep-core[i-1].dep).toBeCloseTo(150,1);
   const outer=core.filter(x=>x.t.kind==='big');const gaps=outer.slice(1).map((x,i)=>x.dep-outer[i].dep);
   expect(gaps.every(g=>Math.abs(g-150)<.05||Math.abs(g-300)<.05)).toBe(true);
   for(let i=1;i<gaps.length;i++)expect(gaps[i]).not.toBeCloseTo(gaps[i-1],1);
  }
 });
});
