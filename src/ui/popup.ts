/**
 * Small panels opened from a field (pickers, drop-down lists), placed in
 * #overlay so that they scale with the UI like everything else. Panels can
 * nest (a list opened from a select inside a picker panel): a click outside
 * closes every panel it is not inside, Esc closes the top one.
 *
 * Native <select> lists are drawn by the browser outside the page and ignore
 * the UI scale (the overlay is scaled with a CSS transform), so they came out
 * larger than the box they drop from. installSelectLists() replaces them, for
 * every select in the overlay, with a list drawn here; picking an entry sets
 * the select's value and fires its change event as the native list would.
 */
import { h } from './dom';

interface Open { el: HTMLElement; field: HTMLElement; close(): void }
const stack: Open[] = [];

function closeFrom(i: number) {
  while (stack.length > i) stack[stack.length - 1].close();
}

document.addEventListener('pointerdown', (e) => {
  const t = e.target as Node;
  for (let i = stack.length - 1; i >= 0; i--) {
    // inside a panel, or on the field it was opened from (whose own handler toggles it)
    if (stack[i].el.contains(t) || stack[i].field.contains(t)) { closeFrom(i + 1); return; }
  }
  closeFrom(0);
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) { e.stopPropagation(); e.preventDefault(); closeFrom(stack.length - 1); }
}, true);

export function closePopups() { closeFrom(0); }

/** is a panel open from this field? */
export function isOpenFrom(field: HTMLElement): boolean {
  return stack.some((p) => p.field === field);
}

/** open `panel` under (or above) `field`, inside #overlay; panels the field is not inside are closed */
export function popup(field: HTMLElement, panel: HTMLElement, cls = 'tp-panel'): Open {
  let keep = 0;
  for (let i = 0; i < stack.length; i++) if (stack[i].el.contains(field)) keep = i + 1;
  closeFrom(keep);
  const root = document.getElementById('overlay') ?? document.body;
  panel.classList.add(cls);
  // clicks in a panel are its own (the view behind must not react to them)
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());
  root.append(panel);
  const or = root.getBoundingClientRect();
  const k = root.offsetWidth ? or.width / root.offsetWidth : 1;
  const fr = field.getBoundingClientRect();
  const W = root.offsetWidth, H = root.offsetHeight;
  const pw = panel.offsetWidth, ph = panel.offsetHeight;
  let x = (fr.left - or.left) / k;
  let y = (fr.bottom - or.top) / k + 4;
  if (y + ph > H - 8) y = Math.max(8, (fr.top - or.top) / k - ph - 4);
  x = Math.max(8, Math.min(W - pw - 8, x));
  panel.style.left = `${x}px`;
  panel.style.top = `${y}px`;
  field.classList.add('on');
  const entry: Open = {
    el: panel, field,
    close: () => {
      panel.remove();
      field.classList.remove('on');
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    },
  };
  stack.push(entry);
  return entry;
}

/** the list of a select, drawn in the overlay at the select's own font */
function openList(sel: HTMLSelectElement) {
  if (isOpenFrom(sel)) { closeFrom(stack.findIndex((p) => p.field === sel)); return; }
  const cs = getComputedStyle(sel);
  const list = h('div', { style: `font-size:${cs.fontSize};font-family:${cs.fontFamily};min-width:${sel.offsetWidth}px` });
  let current: HTMLElement | null = null;
  for (const o of [...sel.options]) {
    const item = h('div', { class: `sl-item ${o.selected ? 'sel' : ''} ${o.disabled ? 'off' : ''}` }, o.text);
    if (o.selected) current = item;
    if (!o.disabled) {
      item.onclick = () => {
        p.close();
        if (sel.value === o.value) return;
        sel.value = o.value;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      };
    }
    list.append(item);
  }
  const p = popup(sel, list, 'sl-panel');
  current?.scrollIntoView({ block: 'nearest' });
}

/** draw every select's list in the overlay instead of the browser's own */
export function installSelectLists(root: HTMLElement) {
  root.addEventListener('mousedown', (e) => {
    const sel = (e.target as HTMLElement).closest?.('select');
    if (!sel || sel.disabled || e.button !== 0 || sel.multiple || sel.size > 1) return;
    e.preventDefault();
    sel.focus();
    openList(sel);
  });
}
