// Seeded generator for the demo cluster, recipe, historical run logs and current plan.
// Every duration distribution is seeded from a public figure (see README "Data"):
//   - Multiply Labs cluster: 4 UR arms, up to 24 instrument modules, 2,000-10,000 doses/yr (multiplylabs.com/product)
//   - CTS DynaCellect isolation ~70-100 min (Thermo Fisher product page / flyer)
//   - CTS Rotea T-cell wash+concentrate: 3 L in 38 min (Thermo Fisher Rotea brochure table)
//   - DMSO exposure before freezing limited to < 1 h (Vox Sanguinis 2015, PMID 25899864)
// Run: node scripts/seed.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { mulberry32 } from '../src/core.js';

const rng = mulberry32(20261111);
const U = (a, b) => a + (b - a) * rng();
const LN = (sigma) => { // lognormal multiplier with median 1
  let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng();
  return Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
};
const r1 = (x) => Math.round(x * 10) / 10;

export const cluster = {
  name: 'Cluster SF-02',
  site: 'Multiply Labs · San Francisco, CA',
  arms: 4,
  modules: [
    { id: 'dyn1', type: 'dyn', label: 'CTS DynaCellect' }, { id: 'dyn2', type: 'dyn', label: 'CTS DynaCellect' },
    { id: 'ncm1', type: 'ncm', label: 'NC-200 counter' },
    { id: 'rot1', type: 'rot', label: 'CTS Rotea' }, { id: 'rot2', type: 'rot', label: 'CTS Rotea' },
    { id: 'fim1', type: 'fim', label: 'Fill module' },
    { id: 'crf1', type: 'crf', label: 'Controlled-rate freezer' }, { id: 'crf2', type: 'crf', label: 'Controlled-rate freezer' },
    ...Array.from({ length: 16 }, (_, i) => ({ id: 'icm' + (i + 1), type: 'icm', label: 'Heracell VIOS incubator (6 G-Rex)' })),
  ],
  icmSlotsPerModule: 6,
};

const H = (ref, edge, lag, name, hold = true) => ({ ref, edge, lag, name, hold });
const W = (lag, name) => ({ ref: null, edge: 'anchor', lag, name, hold: false });
export const recipe = {
  name: 'CD19 CAR-T · 7-day G-Rex · MBR v3.2',
  ops: [
    { key: 'resus', label: 'Bag resuspension', arm: 'h_resus', mod: null, run: null, anchor: 0, pred: null, con: null, tile: 'Start' },
    { key: 'iso', label: 'Isolation', arm: 'h_load', mod: 'dyn', run: 'r_dyn', anchor: null, pred: 0, con: H(0, 'end', 120, 'Apheresis → isolation'), tile: 'Enrich' },
    { key: 'cnt0', label: 'Count', arm: 'h_count', mod: 'ncm', run: 'r_count', anchor: null, pred: 1, con: H(1, 'end', 30, 'Isolation → count'), tile: 'Enrich' },
    { key: 'seed', label: 'G-Rex seed + activate', arm: 'h_seed', mod: null, run: null, anchor: null, pred: 2, con: H(1, 'end', 60, 'Isolation → seeding'), tile: 'Expand' },
    { key: 'trans', label: 'Transduction', arm: 'h_trans', mod: null, run: null, anchor: 1440, pred: 3, con: W(120, 'Transduction window (24 h + 2 h)'), tile: 'Expand' },
    { key: 'feed3', label: 'Cytokine feed', arm: 'h_feed', mod: null, run: null, anchor: 4320, pred: 3, con: W(240, 'Feed window (day 3)'), tile: 'Expand' },
    { key: 'cnt5', label: 'Count', arm: 'h_count', mod: 'ncm', run: 'r_count', anchor: 7200, pred: 3, con: W(240, 'Count window (day 5)'), tile: 'Expand' },
    { key: 'feed5', label: 'Cytokine feed', arm: 'h_feed', mod: null, run: null, anchor: null, pred: 6, con: H(6, 'end', 60, 'Count → feed (day 5)', false), tile: 'Expand' },
    { key: 'harv', label: 'G-Rex harvest', arm: 'h_harvest', mod: null, run: null, anchor: 10080, pred: 3, con: W(240, 'Harvest window (day 7)'), tile: 'Harvest' },
    { key: 'wash', label: 'Wash + concentrate', arm: 'h_load', mod: 'rot', run: 'r_rotea', anchor: null, pred: 8, con: H(8, 'end', 45, 'Harvest → wash'), tile: 'Harvest' },
    { key: 'cnt7', label: 'Count', arm: 'h_count', mod: 'ncm', run: 'r_count', anchor: null, pred: 9, con: H(9, 'end', 30, 'Wash → count'), tile: 'Harvest' },
    { key: 'form', label: 'Formulate (10% DMSO)', arm: 'h_form', mod: null, run: null, anchor: null, pred: 10, con: H(10, 'end', 30, 'Count → formulation'), tile: 'Formulate' },
    { key: 'fill', label: 'Fill final bags', arm: 'h_load', mod: 'fim', run: 'r_fill', anchor: null, pred: 11, con: H(11, 'end', 15, 'Formulation → fill'), tile: 'Formulate' },
    { key: 'frz', label: 'Load CRF', arm: 'h_frz', mod: 'crf', run: 'r_crf', anchor: null, pred: 12, con: H(11, 'start', 60, 'DMSO exposure before freeze'), tile: 'Freeze' },
  ],
};

// ---- historical run logs (what Digital QC would have recorded) ----
const armNominal = { h_resus: 6, h_load: 6, h_count: 3, h_seed: 10, h_trans: 8, h_feed: 5, h_harvest: 12, h_form: 10, h_frz: 5 };
const N_LOG = 600;
const logs = {};
for (const [k, nom] of Object.entries(armNominal)) {
  logs[k] = Array.from({ length: N_LOG }, () => r1(nom * LN(0.1) + (rng() < 0.012 ? U(8, 20) : 0)));
}
logs.r_dyn = Array.from({ length: N_LOG }, () => r1(U(70, 100) + (rng() < 0.05 ? U(15, 35) : 0)));
logs.r_count = Array.from({ length: N_LOG }, () => r1(2.5 * LN(0.15) + (rng() < 0.08 ? U(3, 6) : 0)));
logs.r_rotea = Array.from({ length: N_LOG }, () => r1(38 * LN(0.12) + (rng() < 0.06 ? U(10, 25) : 0)));
logs.r_fill = Array.from({ length: N_LOG }, () => r1(15 * LN(0.1) + (rng() < 0.03 ? U(8, 15) : 0)));
logs.r_crf = Array.from({ length: N_LOG }, () => r1(140 + U(0, 15) + (rng() < 0.02 ? U(20, 40) : 0)));

// ---- current plan: now = Wed 11 Nov 2026 07:00 (minute 0) ----
// Jobs started in the last 7 days by the existing planner (about 12 starts/day), today's and tomorrow's committed
// starts, and the queue of new requests waiting for a start time.
const colors = ['red', 'yellow', 'green', 'purple', 'cyan'];
// History: requests arrived ~12/day (about 4,400 doses/yr, inside the published 2,000-10,000 range); the current planner gave each the earliest start that is conflict-free when
// every step takes its p95 logged duration (a fixed-margin rule). We replay that to build the in-flight plan.
import { makeSampler, makeEvaluator, deterministicStart } from '../src/core.js';
const sampler = makeSampler(logs, 7);
let uid = 1000;
const jobs = [];
const PER_DAY = +(process.env.PER_DAY || 12);
const arrivals = [];
for (let d = -8; d <= 1; d++) for (let i = 0; i < PER_DAY; i++) arrivals.push(d * 1440 + Math.round(i * (14 * 60 / PER_DAY)) + Math.round(U(-30, 30) / 5) * 5);
arrivals.sort((a, b) => a - b);
for (const ready of arrivals) {
  if (ready > 600) break; // requests after 17:00 today are still in the queue
  const ev = makeEvaluator(cluster, recipe, jobs, sampler, { horizonFrom: -100000 });
  const cands = []; for (let t = Math.ceil(ready / 30) * 30; t <= ready + 48 * 60; t += 30) cands.push(t);
  const job = { uid: ++uid, id: 'B-' + (uid + 141) };
  const t = deterministicStart(ev, job, cands, -2);
  if (t == null) throw new Error('no p95 slot for ' + ready);
  jobs.push({ ...job, start: t, ready, status: t < 0 ? 'running' : 'committed' });
}
jobs.sort((a, b) => a.start - b.start);
jobs.forEach((j, i) => { j.color = colors[i % colors.length]; j.coi = 'COI-' + (7300 + (j.uid * 37) % 900); });
const reqReady = arrivals.filter(a => a > 600).slice(0, 8);
const requests = reqReady.map((ready, i) => ({ uid: 2001 + i, id: 'B-' + (1192 + i), coi: 'COI-' + (8100 + i * 37), ready, program: 'Program A', status: 'pending' }));

const plan = {
  now: 0, epoch: '2026-11-11T07:00:00', timezone: 'America/Los_Angeles',
  jobs, requests,
  policy: { eps: 0.01, delta: 0.05, nDesign: 300, nCert: 2000, maxAttempts: 4, designFactor: 0.67, gridMin: 30, searchHours: 36 },
};

mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/cluster.json', import.meta.url), JSON.stringify({ cluster, recipe }, null, 1));
writeFileSync(new URL('../data/logs.json', import.meta.url), JSON.stringify(logs));
writeFileSync(new URL('../data/plan.json', import.meta.url), JSON.stringify(plan, null, 1));
console.log('jobs', jobs.length, 'requests', requests.length, 'log keys', Object.keys(logs).length);
