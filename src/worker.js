// Web Worker wrapper around core.js. Also importable on the main thread (fallback when Workers are unavailable).
import * as C from './core.js';

let ctx = null;
export function init(msg) {
  ctx = { cluster: msg.cluster, recipe: msg.recipe, sample: C.makeSampler(msg.logs, 7), policy: msg.policy };
}
function evaluator(jobs) { return C.makeEvaluator(ctx.cluster, ctx.recipe, jobs, ctx.sample); }

/** Full analysis for one request: streamed design curve, deterministic baselines, certified slot. */
export function analyze(msg, post) {
  const { jobs, req, policy } = msg;
  const ev = evaluator(jobs);
  const cands = C.candidateStarts(req.ready, { gridMin: policy.gridMin, searchHours: policy.searchHours });
  const designS = C.range(0, policy.nDesign);
  const curve = [];
  cands.forEach((t, i) => {
    const r = ev.risk(req, t, designS);
    curve.push({ t, k: r.k, n: r.n, p: r.p });
    if (post && (i % 4 === 3 || i === cands.length - 1)) post({ type: 'progress', done: i + 1, total: cands.length, curve: curve.slice() });
  });
  // certification walk (same rule as C.certifiedStart, reusing the curve)
  const attempts = []; let chosen = null;
  for (const c of curve) {
    if (attempts.length >= policy.maxAttempts) break;
    if (c.p > policy.eps * policy.designFactor) continue;
    const certS = C.range(100000 + attempts.length * policy.nCert, policy.nCert);
    const r = ev.risk(req, c.t, certS, true);
    const ub = C.clopperPearsonUpper(r.k, r.n, policy.delta / policy.maxAttempts);
    const a = { t: c.t, k: r.k, n: r.n, p: r.p, ub, per: r.per, pass: ub <= policy.eps };
    attempts.push(a);
    if (a.pass) { chosen = a; break; }
  }
  const det = { nominal: C.deterministicStart(ev, req, cands, -1), p95: C.deterministicStart(ev, req, cands, -2), worst: C.deterministicStart(ev, req, cands, -3) };
  return { id: req.id, cands, curve, attempts, chosen, det };
}

/** Manual certification of an operator-chosen slot (fresh scenario block, its own confidence level). */
export function certify(msg) {
  const { jobs, req, t, policy, block = 9 } = msg;
  const ev = evaluator(jobs);
  const certS = C.range(100000 + block * policy.nCert, policy.nCert);
  const r = ev.risk(req, t, certS, true);
  return { t, k: r.k, n: r.n, p: r.p, ub: C.clopperPearsonUpper(r.k, r.n, policy.delta), per: r.per, pass: false, manual: true };
}

export function detail(msg) {
  const { jobs, req, t, policy } = msg;
  const ev = evaluator(jobs);
  const b = C.breakdown(ev, req, t, C.range(900000, policy.nCert));
  return { t, k: b.k, n: b.n, byCon: b.byCon, byRes: b.byRes, dmso: b.dmso, hits: b.hits.slice(0, 40), newOps: b.newOps };
}

/** Expected hold-time breaches in the committed plan (no new job), and a nominal timeline for the Gantt. */
export function planStats(msg) {
  const { jobs, nS = 300 } = msg;
  const ev = evaluator(jobs);
  const bp = ev.basePlan;
  let total = 0;
  for (let s = 0; s < nS; s++) { const r = ev.baseline(s); for (let i = 0; i < r.breach.length; i++) if (r.breach[i] && bp.ops[i].con && bp.ops[i].con.hold) total++; }
  return { expectedBreaches: total / nS, nS, jobsInFlight: jobs.filter(j => j.start <= 0).length };
}

/** Nominal (median-duration) execution with an optional new job, for drawing the Planner Gantt. */
export function timeline(msg) {
  const { jobs, req, t } = msg;
  const all = req && t != null ? [...jobs, { ...req, start: t }] : jobs;
  const plan = C.compile(ctx.cluster, ctx.recipe, all, 0);
  const r = C.simulate(plan, ctx.sample, -1);
  const bars = [];
  plan.ops.forEach((o, i) => {
    if (!plan.keep[i] || Number.isNaN(r.start[i])) return;
    bars.push({ j: o.j, k: o.k, s: r.start[i], aEnd: r.start[i] + ctx.sample(o.armKey, -1, o.uid, o.k, 0), e: r.end[i], arm: r.armOf[i], mod: r.modOf[i], br: r.breach[i] && o.con && o.con.hold ? 1 : 0, late: r.late[i] });
  });
  return { bars };
}

const api = { init, analyze, certify, detail, planStats, timeline };
if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (e) => {
    const { id, op, msg } = e.data;
    try {
      const post = (m) => self.postMessage({ id, partial: m });
      const out = api[op](msg, post);
      self.postMessage({ id, result: out });
    } catch (err) {
      self.postMessage({ id, error: String(err && err.stack || err) });
    }
  };
}
export default api;
