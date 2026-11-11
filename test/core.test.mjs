import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../src/core.js';

const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url)));
const { cluster, recipe } = rd('cluster.json');
const logs = rd('logs.json');
const plan = rd('plan.json');
const results = rd('results.json');
const sample = C.makeSampler(logs, 7);

function binomCdf(k, n, p) { // P(X <= k)
  let s = 0, term = Math.pow(1 - p, n);
  for (let i = 0; i <= k; i++) { s += term; term *= (n - i) / (i + 1) * p / (1 - p); }
  return s;
}

test('hash32 is deterministic and input-sensitive', () => {
  assert.equal(C.hash32(1, 2, 3, 4), C.hash32(1, 2, 3, 4));
  const seen = new Set(); for (let i = 0; i < 1000; i++) seen.add(C.hash32(7, i, 0, 0));
  assert.ok(seen.size > 995);
});

test('Clopper-Pearson with zero failures matches the closed form 1 - delta^(1/n)', () => {
  for (const n of [10, 300, 2000]) assert.ok(Math.abs(C.clopperPearsonUpper(0, n, 0.05) - (1 - Math.pow(0.05, 1 / n))) < 1e-9);
});

test('Clopper-Pearson bound solves P(X <= k | p = UB) = delta', () => {
  for (const [k, n] of [[1, 50], [5, 100], [12, 2000], [40, 300]]) {
    const ub = C.clopperPearsonUpper(k, n, 0.05);
    assert.ok(Math.abs(binomCdf(k, n, ub) - 0.05) < 1e-6, `k=${k} n=${n}`);
  }
});

test('incomplete beta symmetry I_x(a,b) = 1 - I_(1-x)(b,a)', () => {
  for (const [x, a, b] of [[0.1, 2, 5], [0.7, 3.5, 1.2], [0.003, 1, 2000]]) assert.ok(Math.abs(C.betaInc(x, a, b) - (1 - C.betaInc(1 - x, b, a))) < 1e-10);
});

test('property: the Clopper-Pearson upper bound covers the true rate at least 95% of the time', () => {
  const rng = C.mulberry32(42); let cover = 0; const T = 1500;
  for (let i = 0; i < T; i++) {
    const p = 0.002 + 0.05 * rng(), n = 200; let k = 0;
    for (let j = 0; j < n; j++) if (rng() < p) k++;
    if (C.clopperPearsonUpper(k, n, 0.05) >= p) cover++;
  }
  assert.ok(cover / T >= 0.95, 'coverage ' + cover / T);
});

test('bootstrap sampler draws logged values; nominal, p95 and worst-case scenarios use log quantiles', () => {
  const set = new Set(logs.r_rotea);
  for (let s = 0; s < 200; s++) assert.ok(set.has(sample('r_rotea', s, 1234, 9, 1)));
  const sorted = [...logs.r_rotea].sort((a, b) => a - b);
  assert.equal(sample('r_rotea', -1, 1, 1), C.quantile(sorted, 0.5));
  assert.equal(sample('r_rotea', -2, 1, 1), C.quantile(sorted, 0.95));
  assert.equal(sample('r_rotea', -3, 1, 1), sorted.at(-1));
});

test('a single job in an empty cluster runs with no breaches and respects precedence and anchors', () => {
  const p = C.compile(cluster, recipe, [{ uid: 1, id: 'J1', start: 0 }]);
  const r = C.simulate(p, sample, -1);
  assert.equal(r.breach.reduce((a, b) => a + b, 0), 0);
  p.ops.forEach((o, i) => {
    if (o.pred >= 0) assert.ok(r.start[i] >= r.end[o.pred] - 1e-9);
    if (o.anchorT != null) assert.ok(r.start[i] >= o.anchorT - 1e-9);
  });
});

test('property: across random scenarios no module or arm is ever double-booked', () => {
  const p = C.compile(cluster, recipe, plan.jobs);
  for (const s of [3, 17, 99, 512]) {
    const r = C.simulate(p, sample, s);
    const byMod = {}, byArm = {};
    p.ops.forEach((o, i) => {
      if (!p.keep[i]) return;
      if (r.modOf[i] >= 0) (byMod[r.modOf[i]] ||= []).push([r.start[i], r.end[i]]);
      const aEnd = r.start[i] + sample(o.armKey, s, o.uid, o.k, 0);
      (byArm[r.armOf[i]] ||= []).push([r.start[i], aEnd]);
    });
    for (const ivs of [...Object.values(byMod), ...Object.values(byArm)]) {
      ivs.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < ivs.length; i++) assert.ok(ivs[i][0] >= ivs[i - 1][1] - 1e-9, 'overlap at scenario ' + s);
    }
  }
});

test('hold-time breach is detected with the right lateness when two harvests share one freezer', () => {
  const tiny = { arms: 4, modules: cluster.modules.filter(m => m.id !== 'crf2' && m.id !== 'rot2') };
  const p = C.compile(tiny, recipe, [{ uid: 1, id: 'A', start: 0 }, { uid: 2, id: 'B', start: 20 }]);
  const r = C.simulate(p, sample, -1);
  const frzB = p.ops.findIndex(o => o.j === 1 && o.k === 13);
  const formB = p.ops.findIndex(o => o.j === 1 && o.k === 11);
  assert.equal(r.breach[frzB], 1);
  assert.ok(Math.abs(r.late[frzB] - (r.start[frzB] - r.start[formB] - 60)) < 1e-9);
  const frzA = p.ops.findIndex(o => o.j === 0 && o.k === 13);
  assert.ok(r.start[frzB] >= r.end[frzA] - 1e-9, 'B waits for A to release the freezer');
});

test('windowed counterfactual evaluation equals the full simulation (randomized pairs)', () => {
  const ev = C.makeEvaluator(cluster, recipe, plan.jobs, sample);
  const req = plan.requests[0];
  const cands = C.candidateStarts(req.ready, {});
  const risky = rd('precomputed.json').curve.filter(c => c.p > 0.02).map(c => c.t);
  assert.ok(risky.length > 0);
  const rng = C.mulberry32(9);
  let hits = 0;
  for (let q = 0; q < 240; q++) {
    const pool = q % 2 ? risky : cands;
    const t = pool[Math.floor(rng() * pool.length)], s = Math.floor(rng() * 5000);
    const pw = ev.planWith({ ...req, start: t });
    const w = ev.evalOne(pw, s);
    const full = C.simulate(pw, sample, s, { _succ: pw._succ });
    const f = C.addedBreach(pw, full, ev.basePlan, ev.baseline(s), pw.jobs.length - 1);
    assert.equal(w.hit, f.hit, `t=${t} s=${s}`);
    if (f.hit) hits++;
  }
  assert.ok(hits > 3, 'test should exercise breaching cases, got ' + hits);
});

test('risk estimates are reproducible (common random numbers)', () => {
  const ev1 = C.makeEvaluator(cluster, recipe, plan.jobs, sample), ev2 = C.makeEvaluator(cluster, recipe, plan.jobs, sample);
  const req = plan.requests[1]; const S = C.range(0, 120);
  for (const t of C.candidateStarts(req.ready, {}).slice(0, 6)) assert.equal(ev1.risk(req, t, S).k, ev2.risk(req, t, S).k);
});

test('candidate starts stay on the grid and inside the operator loading window', () => {
  const c = C.candidateStarts(605, { gridMin: 30, searchHours: 36 });
  assert.ok(c.length > 20);
  for (const t of c) {
    assert.equal(t % 30, 0); assert.ok(t >= 605 && t <= 605 + 36 * 60);
    const clock = (t + 420) % 1440; assert.ok(clock >= 360 && clock <= 1320);
  }
});

test('certified start: chosen slot is the earliest admissible one and its bound is within budget', () => {
  const r = results.rows[0];
  const pre = rd('precomputed.json');
  assert.equal(pre.chosen.t, r.certified.t);
  assert.ok(pre.chosen.ub <= plan.policy.eps);
  for (const c of pre.curve) {
    if (c.t >= pre.chosen.t) break;
    const att = pre.attempts.find(a => a.t === c.t);
    assert.ok(c.p > plan.policy.eps * plan.policy.designFactor || (att && !att.pass), 'skipped an admissible earlier slot at ' + c.t);
  }
});

test('headline numbers in results.json reproduce from the committed data (first request)', () => {
  const ev = C.makeEvaluator(cluster, recipe, plan.jobs, sample);
  const req = plan.requests[0];
  const cands = C.candidateStarts(req.ready, { gridMin: plan.policy.gridMin, searchHours: plan.policy.searchHours });
  const nominal = C.deterministicStart(ev, req, cands, -1);
  assert.equal(nominal, results.rows[0].nominal.t);
  const evalS = C.range(results.evalScenarios.seed, results.evalScenarios.n);
  const rn = ev.risk(req, nominal, evalS);
  assert.equal(rn.k, results.rows[0].nominal.eval.k);
  const rc = ev.risk(req, results.rows[0].certified.t, evalS);
  assert.equal(rc.k, results.rows[0].certified.eval.k);
  const h = results.headline;
  assert.equal(h.nominalOverBudget, results.rows.filter(x => x.nominal && x.nominal.eval.p > plan.policy.eps).length);
  assert.ok(results.rows.every(x => x.certified.eval.p <= plan.policy.eps), 'every certified slot is within budget on held-out scenarios');
});
