/**
 * Label collision index: a uniform grid of placed rectangles. Every label
 * on the schematic (station names, train windows, device IDs, km posts,
 * badges) is placed through it, so no two labels ever overlap; labels that
 * cannot be placed are hidden (level of detail) or moved (stacking with a
 * leader line).
 */
export interface Rect { x: number; y: number; w: number; h: number }

export class LabelIndex {
  private cell: number;
  private grid = new Map<number, Rect[]>();
  /** every placed rectangle (debug / overlap checks) */
  placed: { r: Rect; tag: string }[] = [];

  constructor(cell = 128) {
    this.cell = cell;
  }

  clear() {
    this.grid.clear();
    this.placed = [];
  }

  private keys(r: Rect): number[] {
    const c = this.cell;
    const out: number[] = [];
    const x0 = Math.floor(r.x / c);
    const x1 = Math.floor((r.x + r.w) / c);
    const y0 = Math.floor(r.y / c);
    const y1 = Math.floor((r.y + r.h) / c);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push((x + 4096) * 8192 + (y + 4096));
    return out;
  }

  /** true if r intersects any placed rectangle (with a gap) */
  hits(r: Rect, gap = 2): boolean {
    for (const k of this.keys(r)) {
      const arr = this.grid.get(k);
      if (!arr) continue;
      for (const o of arr) {
        if (r.x < o.x + o.w + gap && r.x + r.w + gap > o.x && r.y < o.y + o.h + gap && r.y + r.h + gap > o.y) return true;
      }
    }
    return false;
  }

  add(r: Rect, tag = '') {
    for (const k of this.keys(r)) {
      let arr = this.grid.get(k);
      if (!arr) { arr = []; this.grid.set(k, arr); }
      arr.push(r);
    }
    this.placed.push({ r, tag });
  }

  /** place at the first free candidate; returns the chosen rectangle or null */
  tryPlace(cands: Rect[], tag = '', gap = 2): Rect | null {
    for (const c of cands) {
      if (!this.hits(c, gap)) {
        this.add(c, tag);
        return c;
      }
    }
    return null;
  }
}

/** text width estimate for layout (CJK full-width, Latin/digits ~0.6 em in mono, 0.55 em proportional) */
export function textWidth(s: string, size: number, mono = false): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x2e80) w += size;
    else if (ch === '·') w += size * 0.5;
    else w += size * (mono ? 0.6 : 0.56);
  }
  return Math.ceil(w);
}

/** list of overlapping pairs among placed rectangles (used by the automated overlap check) */
export function overlaps(rects: { r: Rect; tag: string }[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r;
      const b = rects[j].r;
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) out.push([rects[i].tag, rects[j].tag]);
    }
  }
  return out;
}
