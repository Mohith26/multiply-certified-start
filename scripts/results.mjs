// Computes the committed results file (data/results.json) and the first-paint cache (data/precomputed.json).
// Every number in the README, the email and the app's first paint comes from here or from the same code in-browser.
import { readFileSync, writeFileSync } from 'node:fs';
import * as C from '../src/core.js';

const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url)));
const { cluster, recipe } = rd('cluster.json');
const logs = rd('logs.json');
const plan = rd('plan.json');
const pol = plan.policy;
const sample = C.makeSampler(logs, 7);
const EVAL_SEED = 500000, N_EVAL = 2000;
const evalS = C.range(EVAL_SEED, N_EVAL);

let jobs = plan.jobs.slice();
const rows = [];
let first = null;
const t0 = Date.now();
for (const req of plan.requests) {
  const ev = C.makeEvaluator(cluster, recipe, jobs, sample);
  const cands = C.candidateStarts(req.ready, { gridMin: pol.gridMin, searchHours: pol.searchHours });
  const cert = C.certifiedStart(ev, req, cands, pol);
  const det = { nominal: C.deterministicStart(ev, req, cands, -1), p95: C.deterministicStart(ev, req, cands, -2), worst: C.deterministicStart(ev, req, cands, -3) };
  const trueRisk = (t) => { if (t == null) return null; const r = ev.risk(req, t, evalS); return { k: r.k, n: r.n, p: r.p, ub: C.clopperPearsonUpper(r.k, r.n, 0.05) }; };
  const certT = cert.chosen ? cert.chosen.t : null;
  const row = {
    id: req.id, uid: req.uid, ready: req.ready,
    certified: certT == null ? null : { t: certT, wait: certT - req.ready, cert: { k: cert.chosen.k, n: cert.chosen.n, ub: cert.chosen.ub }, eval: trueRisk(certT), attempts: cert.attempts.length },
  };
  for (const [name, t] of Object.entries(det)) row[name] = t == null ? null : { t, wait: t - req.ready, eval: trueRisk(t) };
  // oracle: earliest candidate whose held-out risk estimate is <= eps (checked only where the design pass is < 3*eps)
  let oracle = null;
  for (const c of cert.curve) { if (certT != null && c.t > certT) break; if (c.p > 3 * pol.eps) continue; const r = ev.risk(req, c.t, evalS); if (r.p <= pol.eps) { oracle = c.t; break; } }
  row.oracle = oracle;
  rows.push(row);
  if (!first) {
    const bd = certT != null ? C.breakdown(ev, req, certT, C.range(pol.certSeedForDetail ?? 900000, pol.nCert)) : null;
    const bdNom = det.nominal != null ? C.breakdown(ev, req, det.nominal, C.range(pol.certSeedForDetail ?? 900000, pol.nCert)) : null;
    first = { id: req.id, cands, curve: cert.curve, attempts: cert.attempts, chosen: cert.chosen, det, detail: { [certT]: strip(bd), [det.nominal]: strip(bdNom) } };
  }
  if (certT == null) throw new Error('no certified slot for ' + req.id);
  jobs = [...jobs, { uid: req.uid, id: req.id, start: certT, ready: req.ready, status: 'committed', color: ['red', 'yellow', 'green', 'purple', 'cyan'][jobs.length % 5], coi: req.coi }];
  console.log(req.id, 'cert', fmt(certT), pct(row.certified.eval.p), '| nominal', fmt(det.nominal), pct(row.nominal?.eval.p), '| p95', fmt(det.p95), pct(row.p95?.eval.p), '| worst', fmt(det.worst), pct(row.worst?.eval.p), '| oracle', fmt(oracle), ev.stats, ((Date.now() - t0) / 1000).toFixed(1) + 's');
}
function strip(b) { if (!b) return null; return { k: b.k, n: b.n, byCon: b.byCon, byRes: b.byRes, dmso: b.dmso.map(x => Math.round(x * 10) / 10), hits: b.hits.slice(0, 40), newOps: b.newOps.map(o => ({ k: o.k, s50: r1(o.s50), s90: r1(o.s90), e50: r1(o.e50), e90: r1(o.e90) })) }; }
function r1(x) { return Math.round(x * 10) / 10; }
function fmt(t) { return t == null ? '-' : (t / 60).toFixed(1) + 'h'; }
function pct(p) { return p == null ? '-' : (100 * p).toFixed(2) + '%'; }
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const agg = {};
for (const pName of ['certified', 'nominal', 'p95', 'worst']) {
  const v = rows.map(r => r[pName]).filter(Boolean);
  agg[pName] = {
    n: v.length,
    meanWaitH: mean(v.map(x => x.wait)) / 60,
    meanRisk: mean(v.map(x => x.eval.p)),
    maxRisk: Math.max(...v.map(x => x.eval.p)),
    expectedBreaches: v.reduce((a, x) => a + x.eval.p, 0),
    overBudget: v.filter(x => x.eval.p > pol.eps).length,
  };
}
const headline = {
  requests: rows.length,
  eps: pol.eps,
  nominalMeanRiskPct: +(100 * agg.nominal.meanRisk).toFixed(1),
  nominalOverBudget: agg.nominal.overBudget,
  certifiedMaxRiskPct: +(100 * agg.certified.maxRisk).toFixed(2),
  certifiedMeanWaitH: +agg.certified.meanWaitH.toFixed(1),
  worstMeanWaitH: +agg.worst.meanWaitH.toFixed(1),
  hoursSoonerThanWorstCase: +(agg.worst.meanWaitH - agg.certified.meanWaitH).toFixed(1),
  oracleMatches: rows.filter(r => r.oracle === r.certified.t).length,
  nominalMaxRiskPct: +(100 * agg.nominal.maxRisk).toFixed(1),
  extraWaitVsNominalMedianMin: median(rows.filter(r => r.nominal).map(r => r.certified.t - r.nominal.t)),
  extraWaitVsNominalMeanH: +(mean(rows.filter(r => r.nominal).map(r => r.certified.t - r.nominal.t)) / 60).toFixed(1),
  worstCaseFeasible: rows.filter(r => r.worst).length,
  p95SameSlotAsNominal: rows.filter(r => r.p95 && r.nominal && r.p95.t === r.nominal.t).length,
};
function median(a) { const s = a.slice().sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; }
writeFileSync(new URL('../data/results.json', import.meta.url), JSON.stringify({ generated: 'scripts/results.mjs', policy: pol, evalScenarios: { seed: EVAL_SEED, n: N_EVAL }, headline, aggregate: agg, rows }, null, 1));
writeFileSync(new URL('../data/precomputed.json', import.meta.url), JSON.stringify(first));
console.log(JSON.stringify(headline, null, 1));
