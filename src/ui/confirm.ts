/**
 * Dispatcher command confirmation (select → command → confirm).
 * Safety-critical commands need a second, timed confirmation (二次确认)
 * with the buttons swapped so a double click cannot confirm by accident.
 */
import { h } from './dom';
import type { Store } from './store';
import type { Command } from '../sim/model';
import { previewBody } from './planpreview';

let overlayRoot: HTMLElement;
let toastRoot: HTMLElement;

export function initConfirm(root: HTMLElement) {
  overlayRoot = root;
  toastRoot = h('div', { class: 'toasts' });
  root.append(toastRoot);
}

export function toast(msg: string, ok: boolean) {
  const t = h('div', { class: `toast ${ok ? 'ok' : 'fail'}` }, msg);
  toastRoot.prepend(t);
  setTimeout(() => t.remove(), 4500);
  while (toastRoot.children.length > 4) toastRoot.lastElementChild?.remove();
}

function modal(title: string, step: string, body: (Node | string)[], critical: boolean, buttons: { label: string; cls: string; value: boolean }[], timeout = 0): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      back.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(false); };
    document.addEventListener('keydown', onKey);
    const cd = h('span', { class: 'countdown' });
    const foot = h('div', { class: 'modal-f' }, timeout ? cd : '');
    for (const b of buttons) foot.append(h('button', { class: `btn ${b.cls}`, onclick: () => finish(b.value) }, b.label));
    const m = h('div', { class: `modal ${critical ? 'critical' : ''}` },
      h('div', { class: 'modal-h' }, h('span', { class: 'stepchip' }, step), title),
      h('div', { class: 'modal-b' }, ...body),
      foot,
    );
    const back = h('div', { class: 'modal-back', onclick: (e: Event) => { if (e.target === back) finish(false); } }, m);
    overlayRoot.append(back);
    if (timeout) {
      let left = timeout;
      cd.textContent = `请在 ${left} 秒内确认`;
      const iv = setInterval(() => {
        left--;
        if (done) { clearInterval(iv); return; }
        if (left <= 0) { clearInterval(iv); finish(false); toast('二次确认超时，命令已取消', false); return; }
        cd.textContent = `请在 ${left} 秒内确认`;
      }, 1000);
    }
  });
}

export interface CmdSpec {
  title: string;
  cmd: Command;
  critical?: boolean;
  detail?: string;
}

export function showIntegritySnapshot(snapshot: import('../sim/invariants').DiagSnapshot) {
  void modal('仿真完整性快照', '报警证据', [
    h('pre', { style: 'max-height:480px;overflow:auto;font-size:14px;white-space:pre-wrap' }, JSON.stringify(snapshot, null, 2)),
  ], false, [{ label: '关闭', cls: '', value: false }]);
}

/** run the confirmation flow and send the command; resolves with the result */
export async function confirmAndSend(store: Store, spec: CmdSpec): Promise<boolean> {
  if (spec.cmd.c === 'overlay' || spec.cmd.c === 'addTrain') {
    const paused = store.snap?.paused ?? false;
    store.send({ type: 'pause', paused: true });
    try {
      const preview = await store.preview(spec.cmd);
      const confirmed = await modal('运行图变更预览', '校验', previewBody(store, preview), false,
        preview.ok ? [{ label: '取消', cls: '', value: false }, { label: '确认应用', cls: 'primary', value: true }]
          : [{ label: '关闭', cls: '', value: false }]);
      if (!confirmed) return false;
      const result = await store.command(spec.cmd);
      toast(result.msg, result.ok);
      return result.ok;
    } finally { store.send({ type: 'pause', paused }); }
  }
  const body: (Node | string)[] = [
    h('div', {}, '即将下达调度命令：'),
    h('div', { class: 'cmdline' }, spec.title),
  ];
  if (spec.detail) body.push(h('div', { class: 'hint' }, spec.detail));
  if (spec.critical) body.push(h('div', { class: 'hint' }, h('b', {}, '安全相关命令'), '，需二次确认。'));
  const ok1 = await modal('命令确认', spec.critical ? '首次确认' : '确认', body, !!spec.critical, [
    { label: '取消', cls: '', value: false },
    { label: spec.critical ? '下一步' : '执行', cls: spec.critical ? 'danger' : 'primary', value: true },
  ]);
  if (!ok1) return false;
  if (spec.critical) {
    const ok2 = await modal('二次确认', '二次确认', [
      h('div', {}, '请再次核对命令对象与内容：'),
      h('div', { class: 'cmdline' }, spec.title),
      h('div', { class: 'hint' }, '确认后命令立即下达联锁/ATS 执行。'),
    ], true, [
      { label: '确认执行', cls: 'danger', value: true },
      { label: '取消', cls: '', value: false },
    ], 10);
    if (!ok2) return false;
  }
  const r = await store.command(spec.cmd);
  toast(`${spec.title}：${r.msg}`, r.ok);
  return r.ok;
}
