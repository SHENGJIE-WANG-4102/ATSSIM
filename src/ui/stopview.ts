/**
 * Stopping close-up for a manually driven train (对标近景): what the driver
 * judges the stop by — the platform screen doors gliding past the cab window
 * and the last PSD pillar before the end door. Stopped right, the driver's
 * window stands at that pillar. It replaces the view out of the window, so it
 * shows no distance figures while the train moves; the error appears once it
 * stands. Plan view; the platform is drawn on the side it lies (top = left
 * looking forward), so in RM — no door enable — this is how the driver knows
 * the side.
 *
 * The scale is non-linear (asinh): the last ten metres open up, the approach
 * along the platform is compressed. Each car and PSD bay is drawn with its five
 * doors where there is room, with one door where it is squeezed, and plain
 * further off. Geometry is approximate 【假设】: 8 cars of 23.25 m (186 m), five
 * doors per side at 4.6 m pitch centred on the car, the driver's eye 1.8 m
 * behind the nose, the end door 2.5 m beyond the last pillar.
 */
import { h } from './dom';
import type { TrainSnap } from '../sim/model';
import { STATIONS } from '../data/line2';
import { FONT_CN } from './theme';

const W = 760;
const H = 200;
const FONT = `Arial, "Helvetica Neue", Helvetica, sans-serif, ${FONT_CN}`;
/** screen x of the stop mark (last pillar) */
const X0 = 560;
/** asinh scale: S metres around the mark are roughly linear */
const S = 3;
const K_BACK = (X0 - 24) / Math.asinh(200 / S);
const K_FWD = (W - 16 - X0) / Math.asinh(20 / S);
const EYE = 1.8;
const CARS = 8;
const CAR = 186 / CARS;
const DOORS = 5;
const DOOR_PITCH = 4.6;
const DOOR_W = 1.4;
const END_DOOR = 2.5;
/** distance before the mark at which the view appears (m) */
export const STOPVIEW_RANGE = 300;
/** Line 2 green */
const LINE = '#8cc220';

const C = {
  bg: '#0b0f16',
  wall: '#20262f',
  floor: '#8b9198',
  joint: '#7c828a',
  tactile: '#e3bd33',
  psdFrame: '#3b4048',
  glass: '#6fa3bf',
  door: '#9cc6da',
  doorOpen: '#1a222c',
  pillar: '#2a2f36',
  pillarLast: '#ffffff',
  endDoor: '#a77e4e',
  bed: '#2e3238',
  sleeper: '#3d424a',
  rail: '#a7b0b9',
  body: '#d9dee3',
  roof: '#b9c0c7',
  ac: '#9aa2ab',
  gangway: '#3a3f46',
  carDoor: '#5d6670',
  windscreen: '#1c2a36',
  eye: '#f0e000',
  red: '#e0505a',
  green: '#3ad06a',
  text: '#d6dde5',
  dim: '#7d8896',
  sign: '#ffffff',
};

/** screen x of a position d metres along the track relative to the stop mark (+ = beyond) */
const xOf = (d: number) => X0 + (d >= 0 ? K_FWD : K_BACK) * Math.asinh(d / S);

/** door centres of one car measured back from its front end (m) */
const carDoors = (front: number) => Array.from({ length: DOORS }, (_, k) => front - CAR / 2 + (k - (DOORS - 1) / 2) * DOOR_PITCH);

/** how many doors a car or PSD bay of this many pixels can show */
const lod = (px: number) => (px >= DOORS * 9 ? DOORS : px >= 7 ? 1 : 0);

export class StopView {
  el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private res = 1;

  constructor(resolution: () => number) {
    this.el = h('canvas', { class: 'stopview' }) as HTMLCanvasElement;
    this.ctx = this.el.getContext('2d')!;
    this.setResolution(resolution());
  }

  setResolution(r: number) {
    this.res = Math.max(1, r);
    this.el.width = Math.round(W * this.res);
    this.el.height = Math.round(H * this.res);
  }

  /** distance the head still has to go to its stopping point, NaN when no stop is near */
  static remaining(t: TrainSnap): number {
    if (!t.platSide || Number.isNaN(t.stopErr)) return NaN;
    return t.stopErr;
  }

  draw(t: TrainSnap) {
    const rem = StopView.remaining(t);
    const show = t.manual && !Number.isNaN(rem) && rem < STOPVIEW_RANGE;
    this.el.style.display = show ? 'block' : 'none';
    if (!show) return;
    const c = this.ctx;
    c.setTransform(this.res, 0, 0, this.res, 0, 0);
    c.fillStyle = C.bg;
    c.fillRect(0, 0, W, H);
    // drawn for a platform on top (driver's left); mirrored otherwise
    const top = t.platSide === 'L';
    const rect = (x: number, y: number, w: number, hh: number, col: string) => {
      c.fillStyle = col;
      c.fillRect(x, top ? y : H - y - hh, w, hh);
    };
    const xEnd = xOf(END_DOOR + 0.8);

    // ---- tunnel walls, platform floor with tile joints and the tactile strip
    rect(0, 0, W, 10, C.wall);
    rect(0, 178, W, 22, C.wall);
    rect(0, 10, xEnd, 62, C.floor);
    rect(xEnd, 10, W - xEnd, 62, C.wall);
    for (let d = -200; d < END_DOOR; d += 1.2) {
      const x = xOf(d);
      if (xOf(d + 1.2) - x >= 5) rect(x, 10, 1, 62, C.joint);
    }
    rect(0, 58, xEnd, 4, C.tactile);

    // ---- track bed, sleepers, rails
    rect(0, 80, W, 98, C.bed);
    for (let d = -200; d < 25; d += 0.6) {
      const x = xOf(d);
      if (xOf(d + 0.6) - x >= 4) rect(x - 1.5, 100, 3, 58, C.sleeper);
    }
    rect(0, 106, W, 3, C.rail);
    rect(0, 150, W, 3, C.rail);

    // ---- platform screen doors: frame along the edge, a bay per car with its doors
    const open = t.doors;
    rect(0, 70, X0, 8, C.psdFrame);
    for (let car = 0; car < CARS; car++) {
      // bays line up with the cars of a train stopped right (nose EYE beyond the last pillar)
      const front = EYE - car * CAR;
      const xa = xOf(front - CAR), xb = car === 0 ? X0 : xOf(front);
      rect(xa, 72, xb - xa, 4, C.glass);
      const n = lod(xb - xa);
      const doors = n === DOORS ? carDoors(front) : n === 1 ? [front - CAR / 2] : [];
      for (const dc of doors) {
        const a = xOf(dc - DOOR_W / 2), b = xOf(dc + DOOR_W / 2);
        rect(a, 71, b - a, 6, open ? C.doorOpen : C.door);
        if (n === DOORS) {
          // the pillars either side of each sliding door
          rect(a - 2, 68, 2, 12, C.pillar);
          rect(b, 68, 2, 12, C.pillar);
        }
      }
    }
    // the last pillar, the end door (端门) and the stop board 8 on the pillar
    rect(X0 + 2, 70, xOf(END_DOOR) - X0 - 2, 8, C.endDoor);
    rect(X0 - 3, 64, 6, 20, C.pillarLast);
    c.fillStyle = C.sign;
    const sy = top ? 26 : H - 26 - 22;
    c.fillRect(X0 - 11, sy, 22, 22);
    c.strokeStyle = '#000';
    c.lineWidth = 1.5;
    c.strokeRect(X0 - 10, sy + 1, 20, 20);
    c.fillStyle = '#000';
    c.font = `bold 17px ${FONT}`;
    c.textAlign = 'center';
    c.fillText('8', X0, sy + 18);

    // ---- the train: nose at -rem + EYE, eight cars back from it
    const nose = -rem + EYE;
    const xNose = xOf(nose);
    for (let car = 0; car < CARS; car++) {
      const front = nose - car * CAR;
      const xb = car === 0 ? xNose - 8 : xOf(front) - 1.5;
      const xa = xOf(front - CAR) + 1.5;
      if (xb < -4) break;
      const w = xb - Math.max(-4, xa);
      if (w <= 0) continue;
      const x = Math.max(-4, xa);
      rect(x, 92, w, 74, C.body);
      rect(x, 104, w, 50, C.roof);
      // Line 2 green band on both sides
      rect(x, 95, w, 4, LINE);
      rect(x, 159, w, 4, LINE);
      // roof air-conditioning units
      const n = lod(xb - xa);
      if (n === DOORS) for (const f of [0.25, 0.75]) {
        const a = xOf(front - CAR * f - 1.8), b = xOf(front - CAR * f + 1.8);
        rect(a, 116, b - a, 26, C.ac);
      }
      if (car > 0) rect(xb, 100, 3, 58, C.gangway);
      // doors on both sides: the platform side dark when open, the far side red when opened there
      const doors = n === DOORS ? carDoors(front) : n === 1 ? [front - CAR / 2] : [];
      for (const dc of doors) {
        const a = xOf(dc - DOOR_W / 2), b = xOf(dc + DOOR_W / 2);
        if (b < 0 || a > xNose) continue;
        rect(a, 91, b - a, 6, t.doors ? C.doorOpen : C.carDoor);
        rect(a, 161, b - a, 6, t.doorSide && !t.doors ? C.red : C.carDoor);
      }
    }
    // cab nose with the windscreen
    c.fillStyle = C.body;
    c.beginPath();
    const yT = top ? 92 : H - 92, yB = top ? 166 : H - 166;
    c.moveTo(xNose - 8, yT); c.quadraticCurveTo(xNose + 2, (yT + yB) / 2, xNose - 8, yB); c.closePath();
    c.fill();
    rect(xNose - 9, 108, 4, 42, C.windscreen);
    // driver's window and the eye mark pointing at the platform side
    const xEye = xOf(-rem);
    rect(xEye - 4, 92, 8, 5, C.windscreen);
    c.fillStyle = C.eye;
    c.beginPath();
    const ey = top ? 86 : H - 86;
    const tip = top ? 79 : H - 79;
    c.moveTo(xEye - 6, ey); c.lineTo(xEye + 6, ey); c.lineTo(xEye, tip);
    c.closePath();
    c.fill();

    // ---- caption: station and side; the error once standing
    c.textAlign = 'left';
    c.font = `15px ${FONT}`;
    c.fillStyle = C.dim;
    const capY = top ? H - 6 : 16;
    const st = STATIONS[t.nextStation]?.name ?? '';
    c.fillText(`${st}  站台在${top ? '左' : '右'}侧`, 10, capY);
    if (t.v < 0.05) {
      const a = Math.abs(rem);
      c.textAlign = 'right';
      c.font = `bold 17px ${FONT}`;
      c.fillStyle = a <= 0.3 ? C.green : a <= 1 ? C.eye : C.red;
      c.fillText(`${rem >= 0 ? '欠标' : '过标'} ${a.toFixed(2)} m`, W - 10, capY);
    }
  }
}
