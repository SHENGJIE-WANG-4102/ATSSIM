import {describe,it,expect} from 'vitest';
import {Sim} from '../src/sim/engine';
import {platformBerth,dayPeriods,OUTER_BAND_MARGIN,TEMPLATES} from '../src/sim/timetable';
import {MAX_DWELL_BUSY} from '../src/sim/calibration';
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
 tr.link=berth.link;tr.off=berth.offset;tr.dir=1;tr.hist=[{link:berth.link,dir:1}];tr.v=0;tr.a=0;tr.eb=false;tr.phase='run';tr.block=-1;tr.tripId=-1;tr.inService=true;tr.load=load;tr.tbStage='none';tr.depotStage='none';
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
 it.each(['weekday','weekend'] as const)('%s dwells never exceed the planned dwell ceiling',dayType=>{
  const s=new Sim({dayType,dateLabel:'calibration',startTime:14400,seed:1});
  for(const t of s.plan.trips.filter(t=>t.revenue&&!t.cancelled))for(const p of t.stops)expect(p.dep-p.arr).toBeLessThanOrEqual(MAX_DWELL_BUSY+.001);
 });
 // Every train counts, including depot moves and non-revenue positioning:
 // passengers on a platform see each one. At the far end of the core the
 // terminating small-route trains do not depart, so arrivals are compared.
 const peakTimes=(s:Sim,dir:'DN'|'UP',st:number)=>s.plan.trips.filter(t=>{
  if(t.cancelled||t.dir!==dir)return false;
  const b=s.plan.blocks[t.block],next=b&&s.plan.trips[b.trips[b.trips.indexOf(t.id)+1]];
  // A same-direction positioning trip and its onward service are one train
  // at their shared station, matching the timetable validator's convention.
  return !(t.to===st&&next?.from===st&&next.dir===dir);
 })
  .flatMap(t=>t.stops.filter(p=>p.st===st).map(p=>({t:st===(dir==='DN'?22:4)?p.arr:p.dep,trip:t})))
  .sort((a,b)=>a.t-b.t);
 it('runs every train at the peak headway (2\'30" AM, 3\'00" PM) through the whole core, depot moves included',()=>{
  const s=new Sim({dayType:'weekday',dateLabel:'calibration',startTime:14400,seed:1});
  const peaks=dayPeriods('weekday').filter(p=>p.template==='weekdayAM'||p.template==='weekdayPM');
  let intervals=0;
  for(const peak of peaks)for(const dir of ['DN','UP'] as const)for(let st=4;st<=22;st++){
   const hw=TEMPLATES[peak.template].headway;
   const tolerance=Math.max(6,hw/20); // unchanged dwell model, wider AM spacing
   const times=peakTimes(s,dir,st).map(x=>x.t);
   // the band starts with the wave already through the core
   const at=times.findIndex(t=>t>=peak.from);
   expect(at,`${dir} station ${st}, band start`).toBeGreaterThan(0);
   const first=times[at]-times[at-1];
   expect(Math.abs(first-hw),`${dir} station ${st}, band start ${first}`).toBeLessThanOrEqual(6);
   for(let i=at+1;i<times.length&&times[i]<peak.to;i++){
    intervals++;
    expect(Math.abs(times[i]-times[i-1]-hw),`${dir} station ${st} at ${(times[i]/3600).toFixed(3)}`).toBeLessThanOrEqual(tolerance);
   }
   if(st===(dir==='DN'?4:22)){const transition=times.filter(t=>t<peak.from-2400&&t>peak.from-4200);
    const gaps=transition.slice(1).map((t,i)=>t-transition[i]);
    expect(gaps.length).toBeGreaterThan(3);expect(gaps.at(-1)!).toBeLessThan(gaps[0]);}
  }
  expect(intervals).toBeGreaterThan(4000);
 });
 it('alternates one and two peak headways on the west end with every train, depot moves included',()=>{
  const s=new Sim({dayType:'weekday',dateLabel:'calibration',startTime:14400,seed:1});
  const peaks=dayPeriods('weekday').filter(p=>p.template==='weekdayAM'||p.template==='weekdayPM');
  let intervals=0;
  // The west end lags (UP) or leads (DN) the core by its running time.
  for(const peak of peaks)for(const dir of ['DN','UP'] as const)for(let st=0;st<=3;st++){
   const hw=TEMPLATES[peak.template].headway;
   const all=s.plan.trips.filter(t=>!t.cancelled&&t.dir===dir).flatMap(t=>t.stops.filter(p=>p.st===st).map(p=>t.to===st?p.arr:p.dep)).sort((a,b)=>a-b);
   const firstAirport=s.plan.trips.find(t=>t.dir==='UP'&&t.from===30&&Math.abs(t.stops[0].dep-6*3600)<1)!;
   const start=dir==='UP'&&peak.template==='weekdayAM'?Math.max(peak.from+OUTER_BAND_MARGIN,firstAirport.stops.at(-1)!.arr+2*hw):peak.from+OUTER_BAND_MARGIN;
   const times=all.filter(t=>t>=start&&t<peak.to-OUTER_BAND_MARGIN);
   const gaps=times.slice(1).map((t,i)=>t-times[i]);
   expect(gaps.length).toBeGreaterThan(20);
   for(let i=0;i<gaps.length;i++){
    intervals++;
    const where=`${dir} station ${st} at ${(times[i+1]/3600).toFixed(3)}: ${gaps[i]}`;
    const tol=Math.max(8,hw*.07);
    expect(Math.abs(gaps[i]-hw)<=tol||Math.abs(gaps[i]-2*hw)<=tol,where).toBe(true);
    if(i)expect(Math.abs(gaps[i]-gaps[i-1]),where).toBeGreaterThan(hw*2/3);
   }
  }
  expect(intervals).toBeGreaterThan(300);
 });
});
