/**
 * Stopping close-up for a manually driven train (对标近景): the head car in
 * detail, fixed under the view, with the platform sliding past it — what the
 * driver judges the stop by out of the side window: the platform screen doors
 * and the last PSD pillar before the end door. Stopped right, the cab window
 * stands at that pillar and every car door faces its PSD door. It replaces the
 * view out of the window, so it shows no distance figures while the train
 * moves; the error appears once it stands. Plan view, linear scale; the
 * platform is drawn on the side it lies (top = left looking forward), so in RM —
 * no door enable — this is how the driver knows the side.
 *
 * Geometry is approximate 【假设】: cars of 23.25 m (8 × = 186 m), five doors
 * per side at 4.6 m pitch from 3 m behind the car front, the driver's eye 1.8 m
 * behind the nose, the end door 2.5 m beyond the last pillar, a 188 m platform.
 */
import { h } from './dom';
import type { TrainSnap } from '../sim/model';
import { STATIONS } from '../data/line2';
import { FONT_CN } from './theme';

const W = 760;
const H = 200;
const FONT = `Arial, "Helvetica Neue", Helvetica, sans-serif, ${FONT_CN}`;
/** pixels per metre */
const PX = 26;
/** screen x of the driver's eye (fixed) */
const XE = 600;
const EYE = 1.8;
const CARS = 8;
const CAR = 186 / CARS;
const DOORS = 5;
const DOOR_PITCH = 4.6;
const FIRST_DOOR = 3.0;
const DOOR_W = 1.4;
const END_DOOR = 2.5;
const PLATFORM = 188;
/** distance before the mark at which the view appears (m) */
export const STOPVIEW_RANGE = 300;
/** Line 2 green */
const LINE = '#8cc220';

const C = {
  bg: '#0b0f16',
  tunnel: '#1d232b',
  floor: '#8b9198',
  joint: '#7d838b',
  tactile: '#e3bd33',
  psdFrame: '#3b4048',
  glass: '#7fb1cc',
  leaf: '#a9d2e4',
  gap: '#141a22',
  mullion: '#2a2f36',
  pillarLast: '#ffffff',
  endDoor: '#a77e4e',
  bed: '#2e3238',
  sleeper: '#454b53',
  rail: '#aab3bc',
  body: '#dde2e7',
  roof: '#c3c9cf',
  ac: '#9aa2ab',
  window: '#2c4352',
  carDoor: '#8b949e',
  doorLine: '#4a525b',
  gangway: '#3a3f46',
  windscreen: '#1c2a36',
  eye: '#f0e000',
  red: '#e0505a',
  green: '#3ad06a',
  dim: '#8a95a3',
  sign: '#ffffff',
};

/** door centres of a car, measured from its front end (m, negative = back) */
const doorsOf = (front: number) => Array.from({ length: DOORS }, (_, k) => front - FIRST_DOOR - k * DOOR_PITCH);

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
      const a = Math.max(-2, x), b = Math.min(W + 2, x + w);
      if (b <= a) return;
      c.fillStyle = col;
      c.fillRect(a, top ? y : H - y - hh, b - a, hh);
    };
    /** screen x of a lineside position p (m from the stop mark, + = beyond) */
    const sx = (p: number) => XE + (p + rem) * PX;
    /** the lineside positions on screen */
    const pLeft = -rem - XE / PX, pRight = -rem + (W - XE) / PX;

    // ---- tunnel, platform floor (tile joints, tactile strip), end wall
    rect(0, 0, W, 80, C.tunnel);
    const pa = Math.max(pLeft, -PLATFORM), pb = Math.min(pRight, END_DOOR + 0.8);
    if (pb > pa) {
      rect(sx(pa), 10, (pb - pa) * PX, 62, C.floor);
      for (let p = Math.ceil(pa / 1.2) * 1.2; p < pb; p += 1.2) rect(sx(p), 10, 1, 62, C.joint);
      rect(sx(pa), 54, (pb - pa) * PX, 6, C.tactile);
    }
    // ---- track bed, sleepers (they stream past), rails
    rect(0, 82, W, 96, C.bed);
    for (let p = Math.floor(pLeft / 0.6) * 0.6; p < pRight; p += 0.6) rect(sx(p) - 3, 98, 6, 62, C.sleeper);
    rect(0, 104, W, 4, C.rail);
    rect(0, 150, W, 4, C.rail);

    // ---- platform screen doors: frame, glass, a sliding door (two leaves) opposite every car door
    if (pb > pa) {
      const fa = Math.max(pLeft, -PLATFORM), fb = Math.min(pRight, 0);
      if (fb > fa) {
        rect(sx(fa), 70, (fb - fa) * PX, 10, C.psdFrame);
        rect(sx(fa), 73, (fb - fa) * PX, 4, C.glass);
      }
      for (let car = 0; car < CARS; car++) {
        for (const dc of doorsOf(EYE - car * CAR)) {
          if (dc < pLeft - 2 || dc > pRight + 2) continue;
          const x = sx(dc - DOOR_W / 2), w = DOOR_W * PX;
          // leaves slide apart behind the fixed panels when open
          const shift = t.doors ? w / 2 : 0;
          rect(x, 71, w, 8, t.doors ? C.gap : C.leaf);
          rect(x - shift, 72, w / 2 - 1, 6, C.leaf);
          rect(x + w / 2 + 1 + shift, 72, w / 2 - 1, 6, C.leaf);
          rect(x - 4, 66, 4, 18, C.mullion);
          rect(x + w, 66, 4, 18, C.mullion);
        }
      }
      // the last pillar, the end door (端门, swinging) and the stop board 8
      rect(sx(0) - 3, 62, 7, 26, C.pillarLast);
      rect(sx(0) + 4, 72, END_DOOR * PX - 6, 6, C.endDoor);
      if (sx(0) > -30 && sx(0) < W + 30) {
        c.fillStyle = C.sign;
        const bx = sx(0) - 13, by = top ? 20 : H - 20 - 26;
        c.fillRect(bx, by, 26, 26);
        c.strokeStyle = '#000';
        c.lineWidth = 2;
        c.strokeRect(bx + 2, by + 2, 22, 22);
        c.fillStyle = '#000';
        c.font = `bold 19px ${FONT}`;
        c.textAlign = 'center';
        c.fillText('8', sx(0), by + 20);
      }
    }

    // ---- the head car, fixed: nose EYE ahead of the eye
    const xNose = XE + EYE * PX;
    const xBack = xNose - CAR * PX;
    rect(0, 90, xBack - 6, 78, C.body);           // the second car
    rect(0, 106, xBack - 6, 46, C.roof);
    rect(0, 93, xBack - 6, 4, LINE);
    rect(0, 161, xBack - 6, 4, LINE);
    rect(xBack - 6, 98, 6, 62, C.gangway);
    rect(xBack, 90, xNose - 14 - xBack, 78, C.body);
    rect(xBack, 106, xNose - 20 - xBack, 46, C.roof);
    // roof air-conditioning units
    for (const f of [0.3, 0.72]) rect(xNose - CAR * PX * f - 45, 112, 90, 34, C.ac);
    // windows and doors on both sides; Line 2 band under the windows
    const doorX = doorsOf(0).map((d) => xNose + d * PX);
    for (const side of [0, 1]) {
      const yWin = side ? 159 : 94, yDoor = side ? 159 : 90;
      const near = side === 0;
      for (let k = 0; k < DOORS; k++) {
        const a = doorX[k] + (DOOR_W / 2) * PX + 6, b = (k ? doorX[k - 1] - (DOOR_W / 2) * PX : xNose - 70) - 6;
        if (b > a) rect(a, yWin, b - a, 5, C.window);
      }
      rect(xBack, side ? 166 : 90, xNose - 14 - xBack, 2, LINE);
      for (const x of doorX) {
        const w = DOOR_W * PX;
        const open = near ? t.doors : !!t.doorSide && !t.doors;
        const col = open ? (near ? C.gap : C.red) : C.carDoor;
        rect(x - w / 2, yDoor, w, 9, col);
        if (!open) rect(x - 0.5, yDoor, 1, 9, C.doorLine);
      }
      // cab side door
      rect(xNose - 70, yDoor, 18, 9, C.carDoor);
    }
    // nose and windscreen
    c.fillStyle = C.body;
    const yT = top ? 90 : H - 90, yB = top ? 168 : H - 168;
    c.beginPath();
    c.moveTo(xNose - 14, yT); c.quadraticCurveTo(xNose + 4, (yT + yB) / 2, xNose - 14, yB); c.closePath();
    c.fill();
    rect(xNose - 20, 104, 8, 50, C.windscreen);
    // driver's seat and the eye mark pointing at the platform side
    rect(XE - 7, 98, 14, 16, C.windscreen);
    c.fillStyle = C.eye;
    c.beginPath();
    const ey = top ? 88 : H - 88, tip = top ? 80 : H - 80;
    c.moveTo(XE - 7, ey); c.lineTo(XE + 7, ey); c.lineTo(XE, tip);
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
