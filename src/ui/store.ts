/**
 * UI-side state: latest snapshot from the worker, plan, events, alarms and
 * the dispatcher's current selection. Also wraps the worker protocol.
 */
import type { Topology } from '../sim/topology';
import type { Command, FromWorker, Plan, SimConfig, SimEvent, Snapshot, ToWorker } from '../sim/model';

export type Selection =
  | { kind: 'signal'; id: number }
  | { kind: 'switch'; id: number }
  | { kind: 'section'; id: number }
  | { kind: 'platform'; id: number }
  | { kind: 'train'; id: number }
  | { kind: 'zone'; id: number }
  | { kind: 'depot'; id: number }
  | null;

type Listener = () => void;

export class Store {
  topo: Topology;
  worker: Worker;
  plan: Plan | null = null;
  snap: Snapshot | null = null;
  events: SimEvent[] = [];
  alarms: SimEvent[] = [];
  selection: Selection = null;
  hover: Selection = null;
  config: SimConfig | null = null;
  planVersion = 0;
  traces = new Map<number, number[]>();
  traceVersion = 0;
  private listeners = new Map<string, Set<Listener>>();
  private nextCmd = 1;
  private pending = new Map<number, (r: { ok: boolean; msg: string }) => void>();

  constructor(topo: Topology, worker: Worker) {
    this.topo = topo;
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
  }

  on(ev: string, fn: Listener) {
    let s = this.listeners.get(ev);
    if (!s) { s = new Set(); this.listeners.set(ev, s); }
    s.add(fn);
    return () => s!.delete(fn);
  }
  emit(ev: string) {
    this.listeners.get(ev)?.forEach((f) => f());
  }

  send(msg: ToWorker) {
    this.worker.postMessage(msg);
  }

  start(config: SimConfig) {
    this.config = config;
    this.events = [];
    this.alarms = [];
    this.traces.clear();
    this.traceVersion++;
    this.selection = null;
    this.send({ type: 'init', config });
  }

  command(cmd: Command): Promise<{ ok: boolean; msg: string }> {
    const id = this.nextCmd++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ type: 'cmd', id, cmd });
    });
  }

  select(sel: Selection) {
    this.selection = sel;
    this.emit('selection');
  }

  private onMessage(m: FromWorker) {
    switch (m.type) {
      case 'ready':
        this.plan = m.plan;
        this.planVersion++;
        this.emit('ready');
        this.emit('plan');
        break;
      case 'plan':
        this.plan = m.plan;
        this.planVersion++;
        this.emit('plan');
        break;
      case 'snap': {
        this.snap = m.snap;
        for (const tr of m.snap.traces) {
          let arr = this.traces.get(tr.train);
          if (!arr) { arr = []; this.traces.set(tr.train, arr); }
          for (const v of tr.pts) arr.push(v);
        }
        if (m.snap.traces.length) this.traceVersion++;
        this.emit('snap');
        break;
      }
      case 'events':
        for (const e of m.events) this.events.push(e);
        if (this.events.length > 6000) this.events.splice(0, this.events.length - 5000);
        this.emit('events');
        break;
      case 'alarms':
        this.alarms = m.alarms;
        this.emit('alarms');
        break;
      case 'cmdResult': {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p({ ok: m.ok, msg: m.msg }); }
        break;
      }
      case 'progress':
        this.progress = m;
        this.emit('progress');
        break;
    }
  }
  progress: { t: number; target: number } | null = null;
}
