// Certified Start: chance-constrained job admission for a robotic cell-therapy cluster.
// Pure ES module, no dependencies. Runs in the browser, in a Web Worker and in Node (tests, scripts).
//
// Model
//   - A cluster has a pool of robot arms and typed instrument modules (DynaCellect, NC-200, Rotea, fill, freezer).
//   - A job follows a recipe: ordered operations, each needing one arm for its handling time and optionally one
//     module of a given type for its full occupancy time.
//   - Validated hold times (e.g. harvest -> wash <= 45 min, DMSO exposure <= 60 min) and timing windows are
//     per-operation constraints: start(op) <= time(ref op edge) + limit.
//   - Execution is simulated with an earliest-deadline-first, non-delay dispatcher, the same kind of rule a
//     real-time orchestrator uses. Durations come from bootstrap resampling of historical run logs.
//   - For a new job and a candidate start time we estimate the probability that admitting it causes ANY
//     hold-time breach (its own, or one it pushes onto a committed job), using common random numbers against
//     the baseline plan, and certify the chosen slot with an exact Clopper-Pearson bound on fresh scenarios.

export const MIN = 1, HOUR = 60, DAY = 1440;

// ---------- deterministic randomness (common random numbers) ----------
export function hash32(a, b = 0, c = 0, d = 0) {
  let h = 0x9e3779b9 ^ Math.imul(a | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) ^ Math.imul(b | 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39) ^ Math.imul(c | 0, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) ^ Math.imul(d | 0, 0x165667b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- statistics ----------
function logGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function betacf(a, b, x) {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d; let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
/** Regularized incomplete beta I_x(a,b). */
export function betaInc(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
/** Exact one-sided Clopper-Pearson upper bound for a binomial proportion. */
export function clopperPearsonUpper(k, n, delta = 0.05) {
  if (n <= 0) return 1;
  if (k >= n) return 1;
  // P(X <= k | p) = 1 - I_p(k+1, n-k). Find p with P(X<=k|p) = delta.
  let lo = k / n, hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const cdf = 1 - betaInc(mid, k + 1, n - k);
    if (cdf > delta) lo = mid; else hi = mid;
  }
  return hi;
}
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---------- duration model: bootstrap from historical run logs ----------
/**
 * logs: { [durationKey]: number[] } historical durations in minutes (from run records).
 * Returns a sampler(key, scenario, jobUid, opIdx, slot) -> minutes, deterministic per arguments.
 * scenario -1 => "nominal": the log median; -2 => the log p95 (fixed-margin rule); -3 => the log maximum
 * (worst-case robust rule).
 */
export function makeSampler(logs, seed = 1) {
  const sorted = {}, med = {}, p95 = {}, mx = {};
  for (const k of Object.keys(logs)) {
    const s = Float64Array.from(logs[k]).sort();
    sorted[k] = s; med[k] = quantile(s, 0.5); p95[k] = quantile(s, 0.95); mx[k] = s[s.length - 1];
  }
  const keyId = {}; Object.keys(logs).forEach((k, i) => { keyId[k] = i + 1; });
  return function sample(key, scenario, jobUid, opIdx, slot = 0) {
    if (scenario === -1) return med[key];
    if (scenario === -2) return p95[key];
    if (scenario === -3) return mx[key];
    const s = sorted[key];
    const h = hash32(seed + scenario * 7919, jobUid, opIdx * 16 + slot, keyId[key]);
    return s[h % s.length];
  };
}

// ---------- plan compilation ----------
/**
 * cluster: { arms: n, modules: [{id, type}] }
 * recipe:  { ops: [{ key, label, arm: durationKey, mod: moduleType|null, run: durationKey|null,
 *                    anchor: minutes|null, pred: index|null, con: {ref, edge:'start'|'end', lag, name}|null }] }
 * jobs:    [{ uid, id, start }]
 * Returns a flat op table for the simulator.
 */
export function compile(cluster, recipe, jobs, horizonFrom = 0) {
  const modTypes = [...new Set(cluster.modules.map(m => m.type))];
  const typeIdx = Object.fromEntries(modTypes.map((t, i) => [t, i]));
  const instByType = modTypes.map(t => cluster.modules.map((m, i) => (m.type === t ? i : -1)).filter(i => i >= 0));
  const ops = [];
  jobs.forEach((job, j) => {
    const base = ops.length;
    recipe.ops.forEach((o, k) => {
      const anchorT = o.anchor == null ? null : job.start + o.anchor;
      ops.push({
        j, k, uid: job.uid, base,
        anchorT,
        pred: o.pred == null ? -1 : base + o.pred,
        armKey: o.arm, runKey: o.run, mt: o.mod == null ? -1 : typeIdx[o.mod],
        con: o.con ? { ref: o.con.ref == null ? -1 : base + o.con.ref, edge: o.con.edge, lag: o.con.lag, name: o.con.name, hold: !!o.con.hold } : null,
      });
    });
  });
  // drop jobs' ops that are entirely in the past (already executed); keep op if its anchor >= horizonFrom or
  // its predecessor chain starts at/after horizonFrom.
  const keep = new Uint8Array(ops.length);
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    if (o.anchorT != null) keep[i] = o.anchorT >= horizonFrom ? 1 : 0;
    else keep[i] = o.pred >= 0 ? keep[o.pred] : 0;
  }
  return { ops, keep, modTypes, instByType, nMods: cluster.modules.length, nArms: cluster.arms, jobs };
}

// ---------- discrete-event simulation ----------
class MinHeap {
  constructor() { this.t = []; this.v = []; }
  get size() { return this.t.length; }
  push(t, v) {
    const T = this.t, V = this.v; let i = T.length; T.push(t); V.push(v);
    while (i > 0) { const p = (i - 1) >> 1; if (T[p] <= t) break; T[i] = T[p]; V[i] = V[p]; i = p; }
    T[i] = t; V[i] = v;
  }
  peek() { return this.t[0]; }
  pop() {
    const T = this.t, V = this.v, v0 = V[0], tl = T.pop(), vl = V.pop(), n = T.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        let l = 2 * i + 1; if (l >= n) break;
        const r = l + 1; if (r < n && T[r] < T[l]) l = r;
        if (T[l] >= tl) break;
        T[i] = T[l]; V[i] = V[l]; i = l;
      }
      T[i] = tl; V[i] = vl;
    }
    return v0;
  }
}

/**
 * Simulate execution of the compiled plan under one duration scenario.
 * opts.only: optional Uint8Array mask of ops to simulate (windowed mode)
 * opts.fixed: optional {start, end} Float64Arrays giving known times for ops outside the mask (baseline)
 * opts.init: optional {armFree, modFree} initial resource availability
 * Returns {start, end, armOf, modOf, breach (Uint8Array per op), late (Float64Array), blocker (Int16Array)}.
 * blocker: -2 none, -1 arms, >=0 module type that gated the start.
 */
export function simulate(plan, sample, scenario, opts = {}) {
  const { ops, keep, instByType, nMods, nArms } = plan;
  const N = ops.length;
  const only = opts.only || keep;
  const start = new Float64Array(N).fill(NaN), end = new Float64Array(N).fill(NaN);
  const armOf = new Int8Array(N).fill(-1), modOf = new Int16Array(N).fill(-1);
  const breach = new Uint8Array(N), late = new Float64Array(N), blocker = new Int16Array(N).fill(-2);
  const lastBlock = new Int16Array(N).fill(-1);
  const fixed = opts.fixed;
  if (fixed) for (let i = 0; i < N; i++) if (!only[i]) { start[i] = fixed.start[i]; end[i] = fixed.end[i]; }
  const armFree = opts.init ? Float64Array.from(opts.init.armFree) : new Float64Array(nArms).fill(-Infinity);
  const modFree = opts.init ? Float64Array.from(opts.init.modFree) : new Float64Array(nMods).fill(-Infinity);
  const aDur = new Float64Array(N), dDur = new Float64Array(N);
  const succ = opts._succ || buildSucc(plan);
  const releaseQ = new MinHeap();
  const relT = new Float64Array(N).fill(NaN);
  for (let i = 0; i < N; i++) {
    if (!only[i]) continue;
    const o = ops[i];
    aDur[i] = sample(o.armKey, scenario, o.uid, o.k, 0);
    dDur[i] = o.mt >= 0 ? aDur[i] + sample(o.runKey, scenario, o.uid, o.k, 1) : aDur[i];
    const predDone = o.pred < 0 || !only[o.pred];
    if (predDone) {
      let r = o.anchorT != null ? o.anchorT : -Infinity;
      if (o.pred >= 0) { const pe = end[o.pred]; if (!Number.isNaN(pe)) r = Math.max(r, pe); }
      if (r === -Infinity) r = 0;
      relT[i] = r; releaseQ.push(r, i);
    }
  }
  const ready = [];
  const deadline = new Float64Array(N);
  const resQ = new MinHeap(); // resource-free events
  for (const x of armFree) if (x > -Infinity) resQ.push(x, 0);
  for (const x of modFree) if (x > -Infinity) resQ.push(x, 0);
  let t = -Infinity, guard = 0;
  while (releaseQ.size || ready.length) {
    if (++guard > 20 * N + 1000) throw new Error('simulate: no progress');
    // next event time
    let nt = Infinity;
    if (releaseQ.size) nt = releaseQ.peek();
    if (ready.length) {
      while (resQ.size && resQ.peek() <= t) resQ.pop();
      if (resQ.size) nt = Math.min(nt, resQ.peek());
      if (nt === Infinity) nt = t; // resources free now
    }
    t = Math.max(t, nt);
    while (releaseQ.size && releaseQ.peek() <= t) {
      const i = releaseQ.pop();
      const o = ops[i];
      let dl = relT[i] + 600; // unconstrained ops: soft priority
      if (o.con) {
        const rt = refTime(o, start, end);
        if (!Number.isNaN(rt)) dl = rt + o.con.lag;
      }
      deadline[i] = dl; ready.push(i);
    }
    if (!ready.length) continue;
    ready.sort((x, y) => deadline[x] - deadline[y] || x - y);
    for (let r = 0; r < ready.length; r++) {
      const i = ready[r], o = ops[i];
      // free arm?
      // any free arm (arms are interchangeable; pick the one idle longest so work spreads across the cell)
      let arm = -1, armT = Infinity, best = Infinity;
      for (let a = 0; a < nArms; a++) { if (armFree[a] <= t) { if (armFree[a] < best) { best = armFree[a]; arm = a; } } else if (armFree[a] < armT) armT = armFree[a]; }
      let mod = -1, modT = Infinity;
      if (o.mt >= 0) {
        const insts = instByType[o.mt];
        for (const m of insts) { if (modFree[m] <= t) { mod = m; break; } if (modFree[m] < modT) modT = modFree[m]; }
      }
      if (arm < 0 || (o.mt >= 0 && mod < 0)) {
        lastBlock[i] = (o.mt >= 0 && mod < 0 && (arm >= 0 || modT >= armT)) ? o.mt : -1;
        continue;
      }
      // start op i at t
      start[i] = t; end[i] = t + dDur[i]; armOf[i] = arm;
      armFree[arm] = t + aDur[i]; resQ.push(armFree[arm], 0);
      if (mod >= 0) { modFree[mod] = t + dDur[i]; modOf[i] = mod; resQ.push(modFree[mod], 0); }
      blocker[i] = t > relT[i] + 1e-9 ? lastBlock[i] : -2;
      // constraint check
      if (o.con) {
        const rt = refTime(o, start, end);
        const lim = (Number.isNaN(rt) ? t : rt) + o.con.lag;
        if (t > lim + 1e-9) { breach[i] = 1; late[i] = t - lim; }
      }
      ready.splice(r, 1); r--;
      for (const s of succ[i]) {
        if (!only[s]) continue;
        const so = ops[s];
        const rr = Math.max(so.anchorT != null ? so.anchorT : -Infinity, end[i]);
        relT[s] = rr; releaseQ.push(rr, s);
      }
    }
  }
  return { start, end, armOf, modOf, breach, late, blocker };
}

function refTime(o, start, end) {
  if (o.con.edge === 'anchor') return o.anchorT;
  return o.con.edge === 'start' ? start[o.con.ref] : end[o.con.ref];
}

export function buildSucc(plan) {
  const succ = plan.ops.map(() => []);
  plan.ops.forEach((o, i) => { if (o.pred >= 0) succ[o.pred].push(i); });
  return succ;
}

// ---------- counterfactual admission risk ----------
/** Ops of job index jNew in a compiled plan. */
export function jobOps(plan, jNew) {
  const out = [];
  plan.ops.forEach((o, i) => { if (o.j === jNew) out.push(i); });
  return out;
}

/** Added-breach indicator for one scenario: does admitting the new job cause any hold-time breach? */
export function addedBreach(planWith, simWith, planBase, simBase, jNew) {
  // planWith has the same ops as planBase in the same order, plus the new job's ops appended at the end.
  const nb = planBase.ops.length;
  for (let i = 0; i < planWith.ops.length; i++) {
    if (!simWith.breach[i]) continue;
    const o = planWith.ops[i];
    if (!o.con || !o.con.hold) continue;
    if (i >= nb) return { hit: true, op: i, own: true };
    if (!simBase.breach[i]) return { hit: true, op: i, own: false };
  }
  return { hit: false };
}

/**
 * Windowed simulation around the new job's operations, exact by construction:
 * ops outside the windows keep their baseline times; resources start from baseline occupancy; and if the
 * perturbation has not died out by the window end we fall back to a full simulation.
 */
export function makeEvaluator(cluster, recipe, jobs, sample, opt = {}) {
  const preWin = opt.preWin ?? 4 * HOUR, postWin = opt.postWin ?? 10 * HOUR, tail = opt.tail ?? 2 * HOUR;
  const basePlan = compile(cluster, recipe, jobs, opt.horizonFrom ?? 0);
  const baseSucc = buildSucc(basePlan);
  const baseCache = new Map();
  function baseline(s) {
    let r = baseCache.get(s);
    if (!r) { r = simulate(basePlan, sample, s, { _succ: baseSucc }); baseCache.set(s, r); }
    return r;
  }
  const stats = { windowed: 0, fallback: 0 };
  // group recipe ops into time clusters by anchor (an op without anchor belongs to its predecessor's cluster)
  const clusterOf = []; const clusterAnchor = [];
  recipe.ops.forEach((o, k) => {
    if (o.anchor != null) { clusterOf[k] = clusterAnchor.length; clusterAnchor.push(o.anchor); }
    else clusterOf[k] = clusterOf[o.pred];
  });
  // merge clusters whose anchors are within postWin of each other
  const groups = [];
  clusterAnchor.forEach((a, c) => {
    const g = groups.find(g => Math.abs(g.a1 - a) < postWin);
    if (g) { g.cs.push(c); g.a0 = Math.min(g.a0, a); g.a1 = Math.max(g.a1, a); } else groups.push({ cs: [c], a0: a, a1: a });
  });

  function planWith(newJob) {
    const p = compile(cluster, recipe, [...jobs, newJob], opt.horizonFrom ?? 0);
    p._succ = buildSucc(p);
    return p;
  }

  /** Evaluate one candidate start for newJob ({uid,id}) at time tStart under scenario s. */
  function evalOne(pw, s) {
    const base = baseline(s);
    const nb = basePlan.ops.length, N = pw.ops.length, jNew = pw.jobs.length - 1;
    const tStart = pw.jobs[jNew].start;
    const fixedStart = new Float64Array(N).fill(NaN), fixedEnd = new Float64Array(N).fill(NaN);
    fixedStart.set(base.start); fixedEnd.set(base.end);
    const breach = new Uint8Array(N); breach.set(base.breach);
    let ok = true;
    const ownBreach = []; let hit = null;
    for (const g of groups) {
      const ws = tStart + g.a0 - preWin, we = tStart + g.a1 + postWin;
      const only = new Uint8Array(N);
      for (let i = 0; i < nb; i++) {
        if (!pw.keep[i]) continue;
        const bs = base.start[i];
        if (bs >= ws && bs <= we) only[i] = 1;
      }
      for (let i = nb; i < N; i++) if (pw.keep[i] && g.cs.includes(clusterOfOp(pw.ops[i].k))) only[i] = 1;
      // initial resources: occupancy of baseline ops that started before ws
      const armFree = new Float64Array(pw.nArms).fill(-Infinity), modFree = new Float64Array(pw.nMods).fill(-Infinity);
      for (let i = 0; i < nb; i++) {
        if (!pw.keep[i] || only[i]) continue;
        const bs = base.start[i]; if (!(bs < ws)) continue;
        const a = base.armOf[i]; if (a >= 0) { const af = bs + (armBusy(base, i, s)); if (af > armFree[a]) armFree[a] = af; }
        const m = base.modOf[i]; if (m >= 0 && base.end[i] > modFree[m]) modFree[m] = base.end[i];
      }
      const r = simulate(pw, sample, s, { only, fixed: { start: fixedStart, end: fixedEnd }, init: { armFree, modFree }, _succ: pw._succ });
      // convergence check: existing ops still active near the window end must match baseline exactly
      for (let i = 0; i < nb; i++) {
        if (!only[i]) continue;
        if (base.end[i] > we - tail || r.end[i] > we - tail) {
          if (Math.abs(r.start[i] - base.start[i]) > 1e-9) { ok = false; break; }
        }
      }
      for (let i = nb; i < N && ok; i++) if (only[i] && r.end[i] > we - tail) ok = false;
      if (!ok) break;
      for (let i = 0; i < N; i++) if (only[i]) { fixedStart[i] = r.start[i]; fixedEnd[i] = r.end[i]; breach[i] = r.breach[i]; }
    }
    if (!ok) {
      stats.fallback++;
      const full = simulate(pw, sample, s, { _succ: pw._succ });
      return { ...addedBreach(pw, full, basePlan, base, jNew), sim: full };
    }
    stats.windowed++;
    const simW = { start: fixedStart, end: fixedEnd, breach };
    return { ...addedBreach(pw, simW, basePlan, base, jNew), sim: simW };
  }
  function clusterOfOp(k) { return clusterOf[k]; }
  function armBusy(base, i, s) {
    const o = basePlan.ops[i];
    return sample(o.armKey, s, o.uid, o.k, 0);
  }

  /** Risk of admitting newJob at tStart: fraction of scenarios with an added hold-time breach. */
  function risk(newJob, tStart, scenarios, detail = false) {
    const pw = planWith({ ...newJob, start: tStart });
    let k = 0; const per = detail ? {} : null; const blockers = detail ? {} : null;
    for (const s of scenarios) {
      const r = evalOne(pw, s);
      if (r.hit) {
        k++;
        if (detail) {
          const o = pw.ops[r.op]; const nm = o.con.name;
          per[nm] = (per[nm] || 0) + 1;
        }
      }
    }
    return { k, n: scenarios.length, p: k / scenarios.length, per, pw };
  }
  return { basePlan, baseline, risk, evalOne, planWith, stats, _sample: sample };
}

export function range(a, n) { const out = []; for (let i = 0; i < n; i++) out.push(a + i); return out; }

/**
 * Certified admission.
 * 1) design pass: estimate risk at each candidate start on nDesign scenarios (common random numbers);
 * 2) walk candidates in time order; the first whose design estimate is <= eps * designFactor is certified on
 *    nCert fresh scenarios with a Clopper-Pearson bound at level delta / maxAttempts (Bonferroni);
 * 3) return the first certified candidate (or null).
 */
export function certifiedStart(ev, newJob, candidates, cfg) {
  const { eps = 0.01, delta = 0.05, nDesign = 200, nCert = 1000, designSeed = 0, certSeed = 100000, maxAttempts = 4, designFactor = 0.5 } = cfg;
  const designS = range(designSeed, nDesign);
  const curve = candidates.map(t => { const r = ev.risk(newJob, t, designS); return { t, k: r.k, n: r.n, p: r.p }; });
  const attempts = [];
  let chosen = null;
  for (const c of curve) {
    if (attempts.length >= maxAttempts) break;
    if (c.p > eps * designFactor) continue;
    const certS = range(certSeed + attempts.length * nCert, nCert);
    const r = ev.risk(newJob, c.t, certS, true);
    const ub = clopperPearsonUpper(r.k, r.n, delta / maxAttempts);
    const a = { t: c.t, k: r.k, n: r.n, p: r.p, ub, per: r.per, pass: ub <= eps };
    attempts.push(a);
    if (a.pass) { chosen = a; break; }
  }
  return { curve, attempts, chosen, eps, delta, nDesign, nCert, maxAttempts };
}

/** Deterministic planner baseline: earliest candidate with no added breach when every duration is the
 * log median (scenario -1, "nominal") or the log p95 (scenario -2, "padded"). */
export function deterministicStart(ev, newJob, candidates, scenario) {
  for (const t of candidates) {
    const r = ev.risk(newJob, t, [scenario]);
    if (r.k === 0) return t;
  }
  return null;
}

/** Candidate start times on a grid, restricted to the operator loading window (clock minutes). */
export function candidateStarts(ready, cfg = {}) {
  const { gridMin = 30, searchHours = 36, windowStart = 6 * 60, windowEnd = 22 * 60, epochClockMin = 7 * 60 } = cfg;
  const out = [];
  for (let t = Math.ceil(ready / gridMin) * gridMin; t <= ready + searchHours * 60; t += gridMin) {
    const clock = ((t + epochClockMin) % 1440 + 1440) % 1440;
    if (clock >= windowStart && clock <= windowEnd) out.push(t);
  }
  return out;
}

/** Breakdown of added breaches by hold-time constraint and by the resource that gated the late start. */
export function breakdown(ev, newJob, tStart, scenarios) {
  const pw = ev.planWith({ ...newJob, start: tStart });
  const byCon = {}, byRes = {}, ownLate = [], dmso = [];
  const nb = ev.basePlan.ops.length;
  const jNew = pw.jobs.length - 1;
  const frzIdx = pw.ops.findIndex((o, i) => i >= nb && o.con && o.con.name.startsWith('DMSO'));
  let k = 0;
  const newIdx = []; for (let i = nb; i < pw.ops.length; i++) if (pw.keep[i]) newIdx.push(i);
  const st = newIdx.map(() => []), en = newIdx.map(() => []);
  for (const s of scenarios) {
    const r = ev.evalOne(pw, s);
    newIdx.forEach((i, q) => { st[q].push(r.sim.start[i]); en[q].push(r.sim.end[i]); });
    if (frzIdx >= 0) { const o = pw.ops[frzIdx]; dmso.push(r.sim.start[frzIdx] - r.sim.start[o.con.ref]); }
    if (!r.hit) continue;
    k++;
    const o = pw.ops[r.op];
    byCon[o.con.name] = (byCon[o.con.name] || 0) + 1;
    // gating resource: rerun full sim for blocker attribution only on hits (rare)
    const full = simulate(pw, ev._sample, s, { _succ: pw._succ });
    const b = full.blocker[r.op];
    const res = b === -1 ? 'arms' : b >= 0 ? pw.modTypes[b] : 'chain';
    byRes[res] = (byRes[res] || 0) + 1;
    ownLate.push({ s, op: r.op, own: r.own, job: pw.jobs[o.j].id, con: o.con.name, late: full.late[r.op] });
  }
  const newOps = newIdx.map((i, q) => {
    const a = Float64Array.from(st[q]).sort(), b = Float64Array.from(en[q]).sort();
    return { k: pw.ops[i].k, s50: quantile(a, 0.5), s90: quantile(a, 0.9), e50: quantile(b, 0.5), e90: quantile(b, 0.9) };
  });
  return { k, n: scenarios.length, byCon, byRes, hits: ownLate, dmso, jNew, newOps };
}
