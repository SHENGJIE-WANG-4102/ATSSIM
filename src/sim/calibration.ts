/** Calibrated service assumptions; factual sources are recorded in D29–D31. */
import type { DayType, TrackDir } from './model';
import { STATIONS } from '../data/line2';
export const RIDERSHIP_TARGET = { weekday: 1_090_000, weekend: 1_090_000 * 0.7 };
export const DOOR_CYCLE = 8; // opening 3 s + warning/closing/lock confirmation 5 s (assumption)
export const MIN_DWELL = 15; // absolute safe operating floor (assumption)
export const MAX_EARLY_HOLD = 10;
export const MAX_DWELL_BUSY = 50; // planned dwell ceiling, busy stations (user decision)
export const MAX_DWELL = 35; // planned dwell ceiling, other stations
export const DOORS_PER_SIDE = 40; // eight cars, five doors per car
export const EXCHANGE_PER_DOOR = 2.2; // persons/s, calibrated aggregate exchange (assumption)
const WEEKDAY: [number, number][] = [[4.5,0],[5.4,.08],[6.2,.4],[6.8,1.2],[7.5,3.4],[8.1,4],[8.8,2.7],[9.6,.8],[11,.65],[13,.7],[16,.8],[17.2,2.6],[18,3.7],[18.8,2.8],[19.8,.85],[21,.5],[22.5,.25],[23.5,.1],[24.5,0]];
const WEEKEND: [number, number][] = [[4.5,0],[5.4,.1],[7,.4],[9,.9],[10.5,1.15],[14,1.2],[17,1.25],[19,1.1],[21,.7],[22.5,.4],[23.5,.15],[24.5,0]];
export function profile(day: DayType, t: number): number {
 const h=t/3600, p=day==='weekday'?WEEKDAY:WEEKEND;
 for(let i=0;i+1<p.length;i++)if(h>=p[i][0]&&h<p[i+1][0])return p[i][1]+(p[i+1][1]-p[i][1])*(h-p[i][0])/(p[i+1][0]-p[i][0]);
 return 0;
}
/** Both directions sum to two: tides redistribute station demand, not its daily total. */
export function directionShare(day: DayType, station: number, dir: TrackDir, t: number): number {
 if(day!=='weekday')return 1;
 const h=t/3600;
 const am=Math.max(0,1-Math.abs(h-8)/2),pm=Math.max(0,1-Math.abs(h-18)/2);
 const west=station<=12?1:station>=17?-1:0;
 const dn=1+.72*west*(am-pm);
 return dir==='DN'?dn:2-dn;
}
export function rawDemand(day: DayType, station: number, dir: TrackDir, t: number): number {
 return STATIONS[station].demand*profile(day,t)*directionShare(day,station,dir,t);
}
/** Boarding demand of a platform. At a line end everyone boards towards the
 * line, so the one departing direction carries the station's whole weight. */
export function boardingDemand(day: DayType, station: number, dir: TrackDir, t: number): number {
 const end=station===0?'DN':station===STATIONS.length-1?'UP':undefined;
 if(end)return dir===end?STATIONS[station].demand*profile(day,t)*2:0;
 return rawDemand(day,station,dir,t);
}
/** Interchanges include transfer boardings in the demand weight. Smooth time variation
 * avoids artificial time jumps when a train straddles a template boundary. */
export function plannedDwell(day: DayType, station: number, dir: TrackDir, t: number): number {
 const busy=STATIONS[station].demand>=1.4;
 const exchange=rawDemand(day,station,dir,t);
 // peak dwells at busy stations up to 50 s: room for a late train to make up time
 return busy?Math.min(MAX_DWELL_BUSY,25+exchange*2):Math.min(MAX_DWELL,20+exchange*2);
}
export function passengerMinimum(board: number, alight: number, crowded: boolean, surge=1): number {
 const rate=DOORS_PER_SIDE*EXCHANGE_PER_DOOR*(crowded?.75:1);
 const exchange=Math.max(7,(board+alight)/rate);
 return Math.max(MIN_DWELL,DOOR_CYCLE+exchange)+Math.min(30,Math.max(0,surge-1)*6);
}
/** Origins keep their published departure slots; the 10-second cap applies to
 * intermediate stops, never to turnback/depot positioning or dispatcher holds. */
export function regulatedDwell(planned: number, minimum: number, arrivalDelay: number): number {
 return Math.max(minimum,planned-(arrivalDelay>0?arrivalDelay:Math.max(-MAX_EARLY_HOLD,arrivalDelay)));
}
