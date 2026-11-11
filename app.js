// RealQC · Planner · Certified Start (unofficial concept demo). All numbers are computed by src/core.js
// from data/*.json, in a Web Worker (or on the main thread if Workers are unavailable).
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LS = 'mlabs-certified-start-v1';
const DAYS = ['Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue'];
const EPOCH_CLOCK = 7 * 60;
const COLORS = ['red', 'yellow', 'green', 'purple', 'cyan'];

function clock(t) { const m = Math.round(t + EPOCH_CLOCK); const d = Math.floor(m / 1440), r = ((m % 1440) + 1440) % 1440; return { d, hh: String(Math.floor(r / 60)).padStart(2, '0'), mm: String(r % 60).padStart(2, '0') }; }
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtT(t, withDate = false) { const c = clock(t); const dt = new Date(Date.UTC(2026, 10, 11 + c.d)); return `${WD[dt.getUTCDay()]}${withDate ? ' ' + dt.getUTCDate() + ' ' + MON[dt.getUTCMonth()] : ''} ${c.hh}:${c.mm}`; }
function fmtHM(t) { const c = clock(t); return `${c.hh}:${c.mm}`; }
function fmtDur(m) { m = Math.round(m); if (Math.abs(m) < 60) return `${m} min`; const h = Math.floor(m / 60), r = m % 60; return r ? `${h} h ${r} min` : `${h} h`; }
const pct = (p, d = 1) => p == null ? '–' : (100 * p).toFixed(d) + '%';

const S = {
  data: null, worker: null, local: null, reqs: new Map(), seq: 0,
  store: { commits: [], eps: null, log: [] },
  route: { tab: 'plan', b: null, slot: null, win: 'd7', view: 'main' },
  analysis: new Map(), detail: new Map(), certs: new Map(), timeline: new Map(), stats: new Map(),
  busy: null,
};

// ---------- persistence ----------
function load() { try { const v = JSON.parse(localStorage.getItem(LS)); if (v && Array.isArray(v.commits)) S.store = { commits: v.commits, eps: v.eps ?? null, log: v.log || [] }; } catch { /* ignore */ } }
function save() { try { localStorage.setItem(LS, JSON.stringify(S.store)); } catch { /* ignore */ } }
function policy() { const p = { ...S.data.plan.policy }; if (S.store.eps) p.eps = S.store.eps; return p; }

// ---------- worker ----------
async function initWorker() {
  const msg = { cluster: S.data.cluster, recipe: S.data.recipe, logs: S.data.logs, policy: S.data.plan.policy };
  try {
    if (location.protocol === 'file:') throw new Error('file');
    const w = new Worker(new URL('./src/worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { const { id, result, error, partial } = e.data; const r = S.reqs.get(id); if (!r) return; if (partial) { r.onPartial && r.onPartial(partial); return; } S.reqs.delete(id); error ? r.reject(new Error(error)) : r.resolve(result); };
    w.onerror = (e) => { console.warn('worker error', e.message); };
    S.worker = w;
    await call('init', msg);
  } catch {
    S.worker = null;
    const mod = await import('./src/worker.js');
    S.local = mod.default; S.local.init(msg);
  }
}
function call(op, msg, onPartial) {
  if (S.worker) return new Promise((resolve, reject) => { const id = ++S.seq; S.reqs.set(id, { resolve, reject, onPartial }); S.worker.postMessage({ id, op, msg }); });
  return new Promise((resolve, reject) => setTimeout(() => { try { resolve(S.local[op](msg, onPartial)); } catch (e) { reject(e); } }, 30));
}

// ---------- derived state ----------
function committedJobs() {
  const base = S.data.plan.jobs;
  const extra = S.store.commits.map((c, i) => { const r = S.data.plan.requests.find(q => q.uid === c.uid); return { uid: r.uid, id: r.id, coi: r.coi, ready: r.ready, start: c.t, status: 'committed', color: COLORS[(base.length + i) % 5], cert: c.cert, override: c.override }; });
  return [...base, ...extra];
}
function pending() { const done = new Set(S.store.commits.map(c => c.uid)); return S.data.plan.requests.filter(r => !done.has(r.uid)); }
function jobsKey() { return S.store.commits.map(c => c.uid + '@' + c.t).join(',') || 'base'; }
function isDefault() { return !S.store.commits.length && (!S.store.eps || S.store.eps === S.data.plan.policy.eps); }
function curReq() { const p = pending(); return p.find(r => r.id === S.route.b) || p[0] || null; }

async function getAnalysis(req) {
  const key = jobsKey() + '|' + req.uid + '|' + policy().eps;
  if (S.analysis.has(key)) return S.analysis.get(key);
  if (isDefault() && S.data.pre && S.data.pre.id === req.id) { S.analysis.set(key, S.data.pre); return S.data.pre; }
  const p = call('analyze', { jobs: committedJobs(), req, policy: policy() }, (part) => { if (part.type === 'progress') { S.busy = part; drawRisk(req, null, part); } });
  S.analysis.set(key, p);
  try { const r = await p; S.analysis.set(key, r); S.busy = null; return r; } catch (e) { S.analysis.delete(key); S.busy = null; throw e; }
}
async function getDetail(req, t) {
  const key = jobsKey() + '|' + req.uid + '|' + t;
  if (S.detail.has(key)) return S.detail.get(key);
  if (isDefault() && S.data.pre && S.data.pre.id === req.id && S.data.pre.detail && S.data.pre.detail[t]) { S.detail.set(key, S.data.pre.detail[t]); return S.data.pre.detail[t]; }
  const p = call('detail', { jobs: committedJobs(), req, t, policy: policy() }); S.detail.set(key, p);
  const r = await p; S.detail.set(key, r); return r;
}
async function getTimeline(req, t) {
  const key = jobsKey() + '|' + (req ? req.uid + '@' + t : 'none');
  if (S.timeline.has(key)) return S.timeline.get(key);
  const p = call('timeline', { jobs: committedJobs(), req, t }); S.timeline.set(key, p);
  const r = await p; S.timeline.set(key, r); return r;
}
async function getStats() {
  const key = jobsKey();
  if (S.stats.has(key)) return S.stats.get(key);
  const p = call('planStats', { jobs: committedJobs(), nS: 300 }); S.stats.set(key, p);
  const r = await p; S.stats.set(key, r); return r;
}

// ---------- routing ----------
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const q = new URLSearchParams(qs || '');
  const parts = (path || 'plan').split('/');
  const tab = ['order', 'mgmt', 'plan', 'run'].includes(parts[0]) ? parts[0] : 'plan';
  S.route = { tab, view: parts[1] === 'detail' ? 'detail' : 'main', b: q.get('b'), slot: q.has('slot') ? +q.get('slot') : null, win: q.get('win') === 'd0' ? 'd0' : 'd7' };
}
function go(patch, replace = false) {
  const r = { ...S.route, ...patch };
  const q = new URLSearchParams();
  if (r.b) q.set('b', r.b); if (r.slot != null) q.set('slot', r.slot); if (r.tab === 'plan' && r.win !== 'd7') q.set('win', r.win);
  const h = `#/${r.tab}${r.view === 'detail' ? '/detail' : ''}${[...q].length ? '?' + q : ''}`;
  if (replace) history.replaceState(null, '', h); else history.pushState(null, '', h);
  parseRoute(); render();
}
window.addEventListener('popstate', () => { parseRoute(); render(); });
window.addEventListener('hashchange', () => { parseRoute(); render(); });

// ---------- shell ----------
function setTabs() { document.querySelectorAll('.tabs a').forEach(a => a.toggleAttribute('aria-current', a.dataset.tab === S.route.tab)); document.querySelectorAll('.tabs a').forEach(a => { if (a.dataset.tab === S.route.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }); }
function icons() { if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.4 } }); }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2600); }
function panelHead(title, extra = '', caps = false) { return `<div class="ph"><h2 class="${caps ? 'caps' : ''}">${title}</h2><div class="tools">${extra}<button type="button" aria-label="Panel settings" title="Panel settings"><i data-lucide="settings"></i></button><button type="button" aria-label="Collapse panel" title="Collapse"><i data-lucide="chevron-down"></i></button></div></div>`; }

function mainPanel(stats) {
  const jobs = committedJobs();
  const inFlight = jobs.filter(j => j.start <= 0 && j.start > -(10080 + 420)).length;
  const eb = stats ? stats.expectedBreaches.toFixed(1) : '…';
  return `<section class="panel">${panelHead('Main')}
    <div class="kv">Program A · CD19 CAR-T<br>San Francisco, CA<br>RealQC SF-02 | MBR v3.2</div>
    <div class="kv" style="margin-top:14px">Status: <span class="ok">Operative</span><br>Jobs in flight:</div>
    <div class="stat"><span class="ico"><i data-lucide="monitor-cog"></i></span><span class="sep"></span><b>${inFlight}</b></div>
    <div class="stat-l">Expected breaches, next 7 d:</div>
    <div class="stat"><span class="ico"><i data-lucide="timer"></i></span><span class="sep"></span><b title="Mean number of validated hold-time breaches across 300 simulated executions of the committed plan">${eb}</b></div>
  </section>`;
}
function queuePanel(sel) {
  const p = pending(); const jobs = committedJobs();
  const done = S.store.commits.slice(-3).reverse().map(c => jobs.find(j => j.uid === c.uid));
  const items = p.map(r => `<li class="${sel && r.uid === sel.uid ? 'sel' : ''}" data-b="${r.id}" tabindex="0" role="button" aria-label="Open request ${r.id}"><span class="qbar"></span><div><div class="t">${r.id}</div><div class="d">Ready ${fmtT(r.ready)} · Pending</div></div></li>`).join('');
  const doneItems = done.map(j => `<li class="done" data-order="1"><span class="qbar"></span><div><div class="t">${j.id}</div><div class="d">Start ${fmtT(j.start)} · ${j.override ? 'Override' : 'Certified'}</div></div></li>`).join('');
  return `<section class="panel" style="margin-top:26px">${panelHead('Queue', `<span class="sub">${p.length} pending</span>`)}
    ${p.length ? `<ul class="qlist" aria-label="Pending start requests">${items}</ul>` : `<div class="empty">All requests have a start time.<br><button class="link" data-act="reset">Reset demo</button></div>`}
    ${doneItems ? `<ul class="qlist" style="margin-top:8px" aria-label="Recently committed">${doneItems}</ul>` : ''}
  </section>`;
}

// ---------- PLAN ----------
async function renderPlan() {
  const app = $('#app');
  const req = curReq();
  const statsP = getStats();
  if (!req) {
    app.innerHTML = `<div class="grid two">${mainPanel(null)}<section class="panel">${panelHead('PLANNER', '', true)}<div class="empty" style="padding:60px">No pending start requests. Every batch in the queue has a committed, certified start.<br><br><button class="btn sec" data-act="reset">Reset demo</button> <a class="btn sec" href="#/order" style="text-decoration:none">Open ORDER</a></div></section></div>`;
    icons(); statsP.then(s => { const el = app.querySelector('.panel'); if (el) el.outerHTML = mainPanel(s); icons(); }); return;
  }
  if (S.route.b !== req.id) { go({ b: req.id, slot: null }, true); return; }
  app.innerHTML = `<div class="grid">
    <div>${mainPanel(S.stats.get(jobsKey()) instanceof Promise ? null : S.stats.get(jobsKey()))}${queuePanel(req)}</div>
    <section class="panel" id="center">${panelHead('PLANNER', '', true)}<div class="plan-bg"><div class="loading"><div class="spin"></div>Planning ${esc(req.id)}…</div></div></section>
    <aside class="panel" id="right">${panelHead('Admission')}<div class="skel" style="height:260px"></div></aside>
  </div>`;
  icons();
  statsP.then(s => { const left = app.querySelector('.grid > div'); if (left && S.route.tab === 'plan') { left.innerHTML = mainPanel(s) + queuePanel(req); icons(); } });
  let a;
  try { a = await getAnalysis(req); } catch (e) { return showError(e); }
  if (S.route.tab !== 'plan' || curReq()?.uid !== req.uid) return;
  const chosen = a.chosen ? a.chosen.t : null;
  const slot = S.route.slot != null && a.cands.includes(S.route.slot) ? S.route.slot : (chosen ?? a.cands[0]);
  S.cur = { req, a, slot };
  drawCenter(req, a, slot);
  drawRight(req, a, slot);
}

function drawCenter(req, a, slot) {
  const c = $('#center'); if (!c) return;
  const win = S.route.win;
  c.innerHTML = `${panelHead('PLANNER', `<span class="sub">${esc(req.id)} proposed at ${fmtT(slot)}</span>`, true)}
  <div class="plan-bg">
    <div class="ctrl">
      <div class="seg" role="group" aria-label="Planner window"><button type="button" data-win="d0" aria-pressed="${win === 'd0'}">DAY 0 · ISOLATION</button><button type="button" data-win="d7" aria-pressed="${win === 'd7'}">DAY 7 · HARVEST → FREEZE</button></div>
      <div class="legend"><span><span class="sw" style="background:var(--blue-d)"></span>${esc(req.id)} (proposed)</span><span><span class="sw" style="background:var(--c-red)"></span>Committed batches</span><span><span class="sw" style="height:1px;background:var(--blue-d)"></span>p90 finish</span><span><span class="sw" style="background:repeating-linear-gradient(135deg,#ff0404 0 3px,#ff5a5a 3px 6px)"></span>Hold time exceeded</span></div>
    </div>
    <div class="gantt" id="gantt"><div class="skel" style="height:420px"></div></div>
  </div>
  <div class="risk">${panelHead('Start-time risk', `<span class="sub">P(admitting ${esc(req.id)} causes any hold-time breach) · ${a.curve[0].n} simulated runs per slot</span>`, true)}
    <div class="chart" id="chart"></div>
  </div>`;
  icons();
  drawRisk(req, a);
  drawGantt(req, slot);
}

async function drawGantt(req, slot) {
  const g = $('#gantt'); if (!g) return;
  const [tl, det] = await Promise.all([getTimeline(req, slot), getDetail(req, slot).catch(() => null)]);
  if (!$('#gantt') || S.cur?.slot !== slot) return;
  const jobs = [...committedJobs(), { ...req, start: slot }];
  const jNew = jobs.length - 1;
  const recipe = S.data.recipe;
  const off = S.route.win === 'd0' ? 0 : 10080;
  const t0 = slot + off - 60, t1 = slot + off + 300;
  const W = g.clientWidth - 66;
  const X = (t) => (t - t0) / (t1 - t0) * W;
  const rows = [...['arm1', 'arm2', 'arm3', 'arm4'].map((id, i) => ({ id, arm: i })), ...S.data.cluster.modules.filter(m => m.type !== 'icm').map((m, i) => ({ id: m.id, mod: i }))];
  const p90 = {}; if (det && det.newOps) det.newOps.forEach(o => { p90[o.k] = o; });
  const late = new Set(); // ops late under nominal durations
  const html = [];
  html.push(`<div class="g-grid">${Array.from({ length: 13 }, (_, i) => `<span style="left:${X(t0 + i * 30)}px"></span>`).join('')}</div>`);
  const ax = X(slot + off);
  html.push(`<div class="g-now" style="left:${66 + ax}px"></div>`);
  html.push(`<div class="g-row exec"><div class="g-lab">Execution</div><div class="g-track"><span class="tag" style="left:${ax + 6}px;top:4px;color:#7d7b7c">${S.route.win === 'd0' ? 'Start · ' + esc(req.id) : 'Harvest · ' + esc(req.id)}</span><span class="tag" style="right:8px;top:4px;color:#9a9899">${S.route.win === 'd0' ? fmtT(slot, true) : fmtT(slot + 10080, true)}</span></div></div>`);
  for (const row of rows) {
    const bars = tl.bars.filter(b => (row.arm != null ? b.arm === row.arm : b.mod === row.mod));
    const cells = []; let tagEnd = -Infinity, barEnd = -Infinity;
    bars.sort((x, y) => x.s - y.s);
    for (const b of bars) {
      const e = row.arm != null ? b.aEnd : b.e;
      if (e < t0 || b.s > t1) continue;
      const x = Math.max(0, X(b.s)), x2 = Math.min(W, X(e)), w = Math.max(3, x2 - x);
      const isNew = b.j === jNew; const job = jobs[b.j];
      const op = recipe.ops[b.k];
      const cls = (isNew ? 'new' : (job.color || 'red')) + (b.br ? ' late' : '');
      const title = `${job.id} · ${op.label} · ${fmtHM(b.s)}–${fmtHM(e)}${row.arm != null ? ' (arm handling)' : ''}${b.br ? ` · hold time exceeded by ${b.late.toFixed(1)} min (${op.con.name})` : ''}`;
      const label = w > 46 ? `${esc(job.id)}` : '';
      cells.push(`<div class="bar ${cls}" style="left:${x}px;width:${w}px" title="${esc(title)}" aria-label="${esc(title)}">${label}</div>`);
      if (!label && row.arm == null && x - 46 >= 4 && x - 46 > Math.max(tagEnd, barEnd) + 2) { cells.push(`<span class="tag" style="left:${x - 46}px">${esc(job.id)}</span>`); tagEnd = x - 4; }
      barEnd = Math.max(barEnd, x2);
      if (isNew && row.mod != null && p90[b.k] && p90[b.k].e90 > e + 0.5) { const xe = Math.min(W, X(p90[b.k].e90)); cells.push(`<span class="whisk" style="left:${x2}px;width:${Math.max(0, xe - x2)}px" title="p90 finish ${fmtHM(p90[b.k].e90)}"></span>`); }
    }
    html.push(`<div class="g-row"><div class="g-lab">${row.id}</div><div class="g-track">${cells.join('')}</div></div>`);
  }
  html.push(`<div class="g-axis">${Array.from({ length: 13 }, (_, i) => { const t = t0 + i * 30; const c = clock(t); return `<span class="${c.mm === '00' ? 'h' : ''}" style="left:${X(t)}px">${c.mm === '00' ? c.hh + ':00' : ':' + c.mm}</span>`; }).join('')}</div>`);
  g.innerHTML = html.join('');
  void late;
}

function drawRisk(req, a, progress) {
  const el = $('#chart'); if (!el) return;
  const pol = policy();
  const curve = a ? a.curve : (progress ? progress.curve : []);
  const cands = a ? a.cands : null;
  if (!a && progress) { el.innerHTML = `<div class="progress" aria-label="Simulating"><span style="width:${(100 * progress.done / progress.total).toFixed(0)}%"></span></div><div class="sub">Simulating ${progress.done}/${progress.total} candidate starts…</div>`; return; }
  if (!a) return;
  const W = Math.max(600, el.clientWidth), H = 214, L = 40, R = 8, T = 22, B = 58;
  const tMin = cands[0], tMax = cands[cands.length - 1] + 30;
  const X = (t) => L + (t - tMin) / (tMax - tMin) * (W - L - R);
  const CAP = 0.2, K = 0.002; const sl = (p) => Math.log10(1 + Math.min(p, CAP) / K) / Math.log10(1 + CAP / K); const Y = (p) => T + (1 - sl(p)) * (H - T - B);
  const bw = (X(tMin + 30) - X(tMin)) - 2;
  const parts = [];
  // night gaps
  for (let i = 1; i < cands.length; i++) if (cands[i] - cands[i - 1] > 30) { const x1 = X(cands[i - 1] + 30), x2 = X(cands[i]); parts.push(`<rect x="${x1}" y="${T}" width="${x2 - x1}" height="${H - T - B}" fill="#f1f3f5"/><text x="${(x1 + x2) / 2}" y="${T + 16}" text-anchor="middle" font-size="10.5" fill="#8a9196" letter-spacing=".06em">OUTSIDE LOADING WINDOW</text>`); }
  // grid
  for (const p of [0, 0.005, 0.02, 0.05, 0.1, 0.2]) parts.push(`<line x1="${L}" x2="${W - R}" y1="${Y(p)}" y2="${Y(p)}" stroke="#e5e8eb"/><text x="${L - 6}" y="${Y(p) + 3.5}" text-anchor="end" font-size="10.5" fill="#666">${p === 0.2 ? '≥20%' : (p * 100) + '%'}</text>`);
  // eps line
  parts.push(`<line x1="${L}" x2="${W - R}" y1="${Y(pol.eps)}" y2="${Y(pol.eps)}" stroke="#195ce7" stroke-dasharray="4 3"/><text x="${W - R}" y="${Y(pol.eps) - 4}" text-anchor="end" font-size="10.5" fill="#195ce7" font-weight="600">Risk budget ${pct(pol.eps, pol.eps < 0.01 ? 1 : 0)}</text>`);
  for (const c of curve) {
    const col = c.p <= pol.eps * pol.designFactor ? '#409858' : c.p <= 0.05 ? '#e0c070' : '#b83224';
    const h = Math.max(2, (H - B) - Y(c.p));
    const sel = S.cur && S.cur.slot === c.t;
    parts.push(`<rect class="c" data-t="${c.t}" x="${X(c.t) + 1}" y="${(H - B) - h}" width="${bw}" height="${h}" fill="${col}" ${sel ? 'stroke="#195ce7" stroke-width="2"' : ''} tabindex="-1"/>`);
    if (c.p > CAP) parts.push(`<path d="M${X(c.t) + 1} ${T + 4} l${bw / 2} -4 l${bw / 2} 4" stroke="#fff" fill="none"/>`);
  }
  // hit area per candidate
  for (const c of curve) parts.push(`<rect class="c" data-t="${c.t}" x="${X(c.t)}" y="${T}" width="${bw + 2}" height="${H - T - B}" fill="transparent" aria-label="${fmtT(c.t)} risk ${pct(c.p)}"/>`);
  // markers
  const mk = (t, label, color, row) => { if (t == null) return; const x = X(t) + 1 + bw / 2; parts.push(`<path d="M${x - 5} ${H - B + 6 + row * 14} l5 -6 l5 6 z" fill="${color}"/><text x="${x + 8}" y="${H - B + 7 + row * 14}" font-size="10.5" fill="${color}" font-weight="600" letter-spacing=".05em">${label}</text>`); };
  mk(a.det.nominal, 'DETERMINISTIC', '#444', 0);
  if (a.chosen) mk(a.chosen.t, 'CERTIFIED', '#195ce7', 1);
  // x labels
  for (const t of cands) { const c = clock(t); if (c.mm === '00' && (+c.hh % 3 === 0)) parts.push(`<text x="${X(t)}" y="${H - B + 46}" font-size="10.5" fill="#555" text-anchor="middle">${c.hh === '06' || t === cands[0] ? DAYS[c.d] + ' ' : ''}${c.hh}:00</text>`); }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Breach risk by candidate start time">${parts.join('')}</svg><div class="tip" id="tip"></div>`;
  const tip = $('#tip', el);
  el.querySelectorAll('rect.c').forEach(r => {
    r.addEventListener('mousemove', (e) => {
      const t = +r.dataset.t; const c = curve.find(x => x.t === t);
      tip.style.display = 'block';
      const bx = el.getBoundingClientRect();
      tip.style.left = Math.min(bx.width - 190, e.clientX - bx.left + 12) + 'px'; tip.style.top = (e.clientY - bx.top - 70) + 'px';
      tip.innerHTML = `<b>${fmtT(t, true)}</b><br>Breach risk <b>${pct(c.p, 1)}</b> (${c.k}/${c.n} runs)${a.chosen && a.chosen.t === t ? '<br><span class="chip info">CERTIFIED</span>' : ''}${a.det.nominal === t ? '<br><span class="chip mute">DETERMINISTIC PICK</span>' : ''}<br><span class="sub">Click to inspect this slot</span>`;
    });
    r.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    r.addEventListener('click', () => go({ slot: +r.dataset.t }));
  });
}

function slotRisk(a, t) { return a.curve.find(c => c.t === t); }
function drawRight(req, a, slot) {
  const r = $('#right'); if (!r) return;
  const pol = policy();
  const ch = a.chosen;
  const certKey = jobsKey() + '|' + req.uid + '|' + slot;
  const manual = S.certs.get(certKey);
  const att = a.attempts.find(x => x.t === slot);
  const certified = (ch && ch.t === slot) ? ch : (manual && !(manual instanceof Promise) && manual.ub <= pol.eps ? manual : null);
  const sr = slotRisk(a, slot);
  const rowsCmp = [
    ['Deterministic (median times)', a.det.nominal], ['Fixed margins (p95 times)', a.det.p95], ['Worst-case bounds (log max)', a.det.worst],
  ].map(([n, t]) => { const c = t != null ? slotRisk(a, t) : null; return `<tr class="${t != null ? 'click' : ''}" ${t != null ? `data-slot="${t}"` : ''}><td>${n}</td><td>${t != null ? fmtT(t) : '<span class="sub">no slot in 36 h</span>'}</td><td>${c ? `<span class="chip ${c.p > pol.eps ? 'bad' : 'ok'}">${pct(c.p)}</span>` : '–'}</td></tr>`; }).join('');
  const certRow = ch ? `<tr class="me click" data-slot="${ch.t}"><td>Certified Start</td><td>${fmtT(ch.t)}</td><td><span class="chip info">≤ ${pct(ch.ub, 2)}</span></td></tr>` : `<tr class="me"><td>Certified Start</td><td colspan="2"><span class="chip bad">no slot meets ${pct(pol.eps)}</span></td></tr>`;
  const wait = slot - req.ready;
  const slotCard = `<div class="card ${certified ? '' : (sr.p > pol.eps ? 'red' : 'grey')}">
      <h3>${certified ? 'Certified slot' : 'Selected slot'}</h3>
      <div class="big">${fmtT(slot, true)}</div>
      <div class="l"><span>Wait after apheresis ready</span><b>${fmtDur(wait)}</b></div>
      <div class="l"><span>Design estimate</span><b>${pct(sr.p, 2)} · ${sr.k}/${sr.n}</b></div>
      ${certified ? `<div class="l"><span>Fresh certification runs</span><b>${certified.k}/${certified.n} breached</b></div>
      <div class="l"><span>Upper bound (${certified.manual ? '95%' : '95% overall'})</span><b>${pct(certified.ub, 2)} ≤ ${pct(pol.eps, pol.eps < 0.01 ? 1 : 0)}</b></div>
      <div class="note">${certified.manual ? 'Exact Clopper-Pearson bound on 2,000 fresh simulated runs.' : `Exact Clopper-Pearson bound on ${certified.n.toLocaleString()} fresh simulated runs, at δ = 0.05/${pol.maxAttempts} per attempt (Bonferroni over up to ${pol.maxAttempts} attempts; ${a.attempts.length} used).`} Runs resample this cluster's logged step durations.</div>`
      : manual instanceof Promise ? `<div class="loading" style="padding:10px 0"><div class="spin"></div>Certifying on 2,000 fresh runs…</div>`
      : manual ? `<div class="l"><span>Fresh certification runs</span><b>${manual.k}/${manual.n} breached</b></div><div class="l"><span>95% upper bound</span><b style="color:#c00">${pct(manual.ub, 2)} > ${pct(pol.eps, 0)}</b></div><div class="note">Not certified at the current risk budget.</div>`
      : att && !att.pass ? `<div class="note">Tried during certification: ${att.k}/${att.n} breached, bound ${pct(att.ub, 2)} > budget.</div>`
      : `<div class="row-btns"><button class="btn sec" data-act="certify">Certify this slot</button></div>`}
      <div class="row-btns"><button class="link" data-act="detail">Why this risk? →</button></div>
    </div>`;
  r.innerHTML = `${panelHead('Admission', `<button type="button" data-act="export" aria-label="Export results" title="Export (E)"><i data-lucide="download"></i></button>`)}
    <div class="kv" style="line-height:1.6;margin-bottom:12px"><b style="font-weight:600;letter-spacing:.08em">${esc(req.id)}</b> · ${esc(req.coi)}<br><span class="sub">${esc(S.data.recipe.name)} · apheresis ready ${fmtT(req.ready, true)}</span></div>
    <table class="cmp" aria-label="Start-time options"><thead><tr><th>Rule</th><th>Start</th><th>Breach risk</th></tr></thead><tbody>${rowsCmp}${certRow}</tbody></table>
    ${slotCard}
    <button class="btn" data-act="commit" ${certified ? '' : 'aria-describedby="ovr"'}>${certified ? 'Commit start' : 'Commit with override'}</button>
    ${certified ? '' : `<div id="ovr" class="note sub" style="margin-top:6px">This slot is not certified at ${pct(pol.eps, 0)}; committing records an override in RUN INFO.</div>`}`;
  icons();
}

// ---------- detail ----------
async function renderDetail() {
  const app = $('#app');
  const req = curReq();
  if (!req) { go({ view: 'main' }, true); return; }
  app.innerHTML = `<div class="loading"><div class="spin"></div>Simulating 2,000 runs for ${esc(req.id)}…</div>`;
  let a, d;
  try { a = await getAnalysis(req); const t = S.route.slot ?? (a.chosen ? a.chosen.t : a.cands[0]); d = await getDetail(req, t); } catch (e) { return showError(e); }
  if (S.route.view !== 'detail') return;
  const t = d.t ?? S.route.slot ?? a.chosen?.t;
  const pol = policy();
  const total = d.k / d.n;
  const cons = S.data.recipe.ops.filter(o => o.con && o.con.hold).map(o => o.con);
  const conRows = cons.map(c => { const k = (d.byCon && d.byCon[c.name]) || 0; return `<tr><td>${esc(c.name)}</td><td class="num">${c.lag} min</td><td class="num">${k}</td><td class="num">${pct(k / d.n, 2)}</td></tr>`; }).join('');
  const resNames = { crf: 'Freezer (CRF)', fim: 'Fill module', rot: 'Rotea', ncm: 'NC-200', dyn: 'DynaCellect', arms: 'Robot arms', chain: 'Upstream step ran long' };
  const resTot = Object.values(d.byRes || {}).reduce((x, y) => x + y, 0) || 1;
  const resBars = Object.entries(d.byRes || {}).sort((x, y) => y[1] - x[1]).map(([k, v]) => `<div class="hbar"><span>${resNames[k] || k}</span><div class="track"><div class="fill" style="width:${(100 * v / resTot).toFixed(1)}%"></div></div><span class="num">${v}</span></div>`).join('') || `<div class="empty">No breaching runs in this sample.</div>`;
  // DMSO histogram
  const dm = d.dmso || [];
  const bins = new Array(16).fill(0); dm.forEach(x => { const b = Math.min(15, Math.max(0, Math.floor((x - 15) / 5))); bins[b]++; });
  const mx = Math.max(1, ...bins); const HW = 520, HH = 150;
  const hist = bins.map((v, i) => { const x0 = 15 + i * 5; const h = v / mx * (HH - 30); return `<rect x="${30 + i * 30}" y="${HH - 20 - h}" width="26" height="${h}" fill="${x0 >= 60 ? '#b83224' : '#58b0c8'}"><title>${x0}–${x0 + 5} min: ${v} runs</title></rect>`; }).join('');
  const limX = 30 + (60 - 15) / 5 * 30 - 2;
  const hits = (d.hits || []).slice(0, 12).map(h => `<tr><td>#${h.s}</td><td>${esc(h.job)}${h.own ? '' : ' <span class="chip warn">pushed</span>'}</td><td>${esc(h.con)}</td><td class="num">+${h.late.toFixed(1)} min</td></tr>`).join('');
  app.innerHTML = `<div class="crumb"><a href="#/plan?b=${req.id}&slot=${t}">PLAN</a> / <span>${esc(req.id)}</span> / <span>${fmtT(t, true)}</span></div>
  <div class="grid two" style="grid-template-columns: 300px minmax(0,1fr)">
    <section class="panel">${panelHead('Slot')}
      <div class="card ${total > pol.eps ? 'red' : ''}"><h3>${esc(req.id)} at ${fmtT(t)}</h3><div class="big">${pct(total, 2)}</div>
        <div class="l"><span>Runs with an added breach</span><b>${d.k}/${d.n}</b></div>
        <div class="l"><span>95% upper bound</span><b>${pct(boundCP(d.k, d.n), 2)}</b></div>
        <div class="note">Counterfactual: the same 2,000 duration draws are run with and without ${esc(req.id)}; a run counts only if admitting it creates a breach (its own, or one it pushes onto a committed batch).</div>
      </div>
      <button class="btn" data-act="commit">${a.chosen && a.chosen.t === t ? 'Commit start' : 'Commit with override'}</button>
      <div class="row-btns"><a class="btn sec" style="text-decoration:none" href="#/plan?b=${req.id}&slot=${t}">← Back to planner</a></div>
    </section>
    <section class="panel">${panelHead('Why this risk', '', false)}
      <div class="dgrid">
        <div><div class="sub" style="margin-bottom:6px;letter-spacing:.1em">BREACHES BY VALIDATED HOLD TIME</div>
          <table class="tbl"><thead><tr><th>Hold time</th><th class="num">Limit</th><th class="num">Runs</th><th class="num">Rate</th></tr></thead><tbody>${conRows}</tbody></table></div>
        <div><div class="sub" style="margin-bottom:6px;letter-spacing:.1em">WHAT THE LATE STEP WAS WAITING FOR</div>${resBars}
          <div class="sub" style="margin:18px 0 6px;letter-spacing:.1em">${esc(req.id)} DMSO EXPOSURE BEFORE FREEZE (2,000 RUNS)</div>
          <svg viewBox="0 0 ${HW} ${HH}" width="100%" role="img" aria-label="Histogram of DMSO exposure minutes">${hist}<line x1="${limX}" x2="${limX}" y1="6" y2="${HH - 20}" stroke="#ff0404" stroke-dasharray="3 3"/><text x="${limX + 4}" y="14" font-size="11" fill="#ff0404">60 min limit</text>${[15, 30, 45, 60, 75, 90].map(v => `<text x="${30 + (v - 15) / 5 * 30}" y="${HH - 6}" font-size="10.5" fill="#555" text-anchor="middle">${v}</text>`).join('')}</svg>
        </div>
      </div>
      <div class="sub" style="margin:22px 0 6px;letter-spacing:.1em">BREACHING RUNS (FIRST 12)</div>
      ${hits ? `<table class="tbl"><thead><tr><th>Run</th><th>Batch</th><th>Hold time</th><th class="num">Late by</th></tr></thead><tbody>${hits}</tbody></table>` : `<div class="empty">None of the 2,000 runs breached a hold time at this slot.</div>`}
    </section>
  </div>`;
  icons();
}
function boundCP(k, n) { // small exact helper mirroring core.clopperPearsonUpper (bisection on the binomial CDF)
  if (k >= n) return 1; let lo = k / n, hi = 1;
  const cdf = (p) => { let s = 0, term = Math.pow(1 - p, n); for (let i = 0; i <= k; i++) { s += term; term *= (n - i) / (i + 1) * p / (1 - p); } return s; };
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (cdf(m) > 0.05) lo = m; else hi = m; } return hi;
}

// ---------- ORDER ----------
function renderOrder() {
  const app = $('#app');
  const jobs = committedJobs(); const p = pending();
  const q = (S.orderQ || '').toLowerCase();
  const rows = [
    ...p.map(r => ({ id: r.id, coi: r.coi, ready: r.ready, start: null, st: 'Pending', risk: null, req: true })),
    ...jobs.filter(j => j.start > -3 * 1440).slice().reverse().map(j => ({ id: j.id, coi: j.coi, ready: j.ready, start: j.start, st: j.start <= 0 ? 'Running' : 'Committed', risk: j.cert ? j.cert.ub : null, ovr: j.override })),
  ].filter(r => !q || (r.id + ' ' + r.coi).toLowerCase().includes(q));
  app.innerHTML = `<section class="panel">${panelHead('ORDER', `<input class="search" id="oq" placeholder="Search batch or COI" aria-label="Search orders" value="${esc(S.orderQ || '')}">`, true)}
    <table class="tbl"><thead><tr><th>Batch</th><th>Chain of identity</th><th>Apheresis ready</th><th>Start</th><th>Status</th><th class="num">Certified risk</th><th></th></tr></thead>
    <tbody>${rows.map(r => `<tr class="${r.req ? 'click' : ''}" ${r.req ? `data-b="${r.id}"` : ''}><td><b style="font-weight:600">${r.id}</b></td><td>${r.coi}</td><td>${r.ready != null ? fmtT(r.ready, true) : '–'}</td><td>${r.start != null ? fmtT(r.start, true) : '–'}</td><td><span class="chip ${r.st === 'Pending' ? 'warn' : r.st === 'Running' ? 'mute' : 'ok'}">${r.st.toUpperCase()}</span>${r.ovr ? ' <span class="chip bad">OVERRIDE</span>' : ''}</td><td class="num">${r.risk != null ? '≤ ' + pct(r.risk, 2) : '–'}</td><td class="num">${r.req ? '<span class="link">Plan →</span>' : ''}</td></tr>`).join('') || `<tr><td colspan="7"><div class="empty">No orders match “${esc(q)}”.</div></td></tr>`}</tbody></table>
    <div class="sub" style="margin-top:8px">${p.length} pending · ${jobs.filter(j => j.start > 0).length} committed · showing batches started in the last 3 days</div></section>`;
  icons();
  const oq = $('#oq'); oq.addEventListener('input', () => { S.orderQ = oq.value; const pos = oq.selectionStart; renderOrder(); const n = $('#oq'); n.focus(); n.setSelectionRange(pos, pos); });
}

// ---------- MGMT ----------
async function renderMgmt() {
  const app = $('#app'); const pol = policy();
  app.innerHTML = `<div class="loading"><div class="spin"></div>Loading cluster…</div>`;
  const tl = await getTimeline(null, null);
  const H = 7 * 1440; const util = {};
  tl.bars.forEach(b => { if (b.mod >= 0) { const s = Math.max(0, b.s), e = Math.min(H, b.e); if (e > s) util[b.mod] = (util[b.mod] || 0) + (e - s); } });
  const mods = S.data.cluster.modules;
  const cards = mods.filter(m => m.type !== 'icm').map((m, i) => `<div class="mod"><b>${m.id.toUpperCase()}</b><div>${esc(m.label)}</div><div>Status: OK</div><div>Util. 7 d: ${pct((util[i] || 0) / H, 0)}</div></div>`).join('')
    + `<div class="mod idle"><b>ICM1–ICM16</b><div>Heracell VIOS ×16</div><div>${16 * S.data.cluster.icmSlotsPerModule} G-Rex slots</div><div>Status: OK</div></div>`;
  app.innerHTML = `<div class="grid two" style="grid-template-columns:minmax(0,1fr) 420px">
    <section class="panel">${panelHead('MGMT · Modules', `<span class="sub">${S.data.cluster.name} · 4 UR arms · ${mods.length} modules</span>`, true)}<div class="mods">${cards}</div></section>
    <section class="panel">${panelHead('Certification policy')}
      <div class="form">
        <label for="eps">Risk budget per admission</label><select id="eps">${[0.005, 0.01, 0.02, 0.05].map(e => `<option value="${e}" ${e === pol.eps ? 'selected' : ''}>${pct(e, e < 0.01 ? 1 : 0)} hold-time breach risk</option>`).join('')}</select>
        <label>Confidence</label><div>95% (exact Clopper-Pearson)</div>
        <label>Design / certification runs</label><div>${pol.nDesign} / ${pol.nCert.toLocaleString()} per slot</div>
        <label>Start grid · search horizon</label><div>${pol.gridMin} min · ${pol.searchHours} h</div>
        <label>Loading window</label><div>06:00–22:00 (operator bag loading)</div>
      </div>
      <div class="row-btns" style="margin-top:20px"><button class="btn sec" data-act="reset">Reset demo state</button></div>
      <div class="note sub" style="margin-top:10px">Changing the budget re-plans the queue against the committed plan. State is kept in this browser (localStorage).</div>
    </section></div>`;
  icons();
  $('#eps').addEventListener('change', (e) => { S.store.eps = +e.target.value; save(); toast(`Risk budget set to ${pct(S.store.eps, S.store.eps < 0.01 ? 1 : 0)}`); });
}

// ---------- RUN INFO ----------
function renderRun() {
  const app = $('#app');
  const log = S.store.log.slice().reverse();
  const keys = Object.keys(S.data.logs);
  const label = { h_resus: 'Arm · bag resuspension', h_load: 'Arm · module load', h_count: 'Arm · count load', h_seed: 'Arm · G-Rex seed', h_trans: 'Arm · transduction', h_feed: 'Arm · feed', h_harvest: 'Arm · harvest', h_form: 'Arm · formulation', h_frz: 'Arm · CRF load', r_dyn: 'DynaCellect run', r_count: 'NC-200 count', r_rotea: 'Rotea wash + concentrate', r_fill: 'Fill run', r_crf: 'CRF occupancy' };
  const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); const pos = (s.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos); return s[lo] + (s[hi] - s[lo]) * (pos - lo); };
  const drows = keys.map(k => { const a = S.data.logs[k]; return `<tr><td>${label[k] || k}</td><td class="num">${a.length}</td><td class="num">${q(a, .5).toFixed(1)}</td><td class="num">${q(a, .95).toFixed(1)}</td><td class="num">${Math.max(...a).toFixed(1)}</td></tr>`; }).join('');
  app.innerHTML = `<div class="grid two" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
    <section class="panel">${panelHead('RUN INFO · Admission log', `<button type="button" data-act="exportlog" title="Export log" aria-label="Export log"><i data-lucide="download"></i></button>`, true)}
      ${log.length ? `<table class="tbl"><thead><tr><th>Time</th><th>Batch</th><th>Start</th><th class="num">Bound</th><th>Decision</th></tr></thead><tbody>${log.map(l => `<tr><td>${new Date(l.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>${l.id}</td><td>${fmtT(l.t, true)}</td><td class="num">${l.ub != null ? pct(l.ub, 2) : '–'}</td><td>${l.override ? '<span class="chip bad">OVERRIDE</span>' : '<span class="chip ok">CERTIFIED</span>'} <span class="sub">${l.k}/${l.n}</span></td></tr>`).join('')}</tbody></table>` : `<div class="empty">No admissions yet. Commit a start in PLAN and it is recorded here with its certificate.</div>`}
    </section>
    <section class="panel">${panelHead('Step duration logs', `<span class="sub">source of the risk model</span>`, true)}
      <table class="tbl"><thead><tr><th>Step</th><th class="num">Runs</th><th class="num">p50 min</th><th class="num">p95 min</th><th class="num">Max min</th></tr></thead><tbody>${drows}</tbody></table>
    </section></div>`;
  icons();
}

// ---------- actions ----------
async function commit() {
  const c = S.cur; if (!c) return;
  const { req, a, slot } = c; const pol = policy();
  const key = jobsKey() + '|' + req.uid + '|' + slot;
  const manual = S.certs.get(key);
  const cert = a.chosen && a.chosen.t === slot ? a.chosen : (manual && !(manual instanceof Promise) ? manual : null);
  const ok = cert && cert.ub <= pol.eps;
  const sr = slotRisk(a, slot);
  const dlg = $('#dlg');
  dlg.innerHTML = `<form method="dialog"><div class="dlg-h" id="dlgTitle">${ok ? 'Commit certified start' : 'Commit with override'}</div>
    <div class="dlg-b">${esc(req.id)} will start <b>${fmtT(slot, true)}</b>. ${ok ? `Certified: ${cert.k}/${cert.n} fresh runs breached, upper bound ${pct(cert.ub, 2)} ≤ ${pct(pol.eps, pol.eps < 0.01 ? 1 : 0)}.` : `This slot is <b>not certified</b>; design estimate ${pct(sr.p, 2)}${cert ? `, bound ${pct(cert.ub, 2)}` : ''}. The override is written to the admission log.`}</div>
    <div class="dlg-f"><button class="btn sec" value="cancel">Cancel</button><button class="btn" value="ok" autofocus>${ok ? 'Commit' : 'Override and commit'}</button></div></form>`;
  dlg.showModal();
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const entry = { uid: req.uid, t: slot, cert: cert ? { k: cert.k, n: cert.n, ub: cert.ub } : null, override: !ok };
    S.store.commits.push(entry);
    S.store.log.push({ at: new Date().toISOString(), id: req.id, t: slot, k: cert ? cert.k : sr.k, n: cert ? cert.n : sr.n, ub: cert ? cert.ub : null, override: !ok, eps: pol.eps });
    save();
    toast(`${req.id} committed for ${fmtT(slot)}${ok ? ' · certified' : ' · override logged'}`);
    const next = pending()[0];
    go({ tab: 'plan', view: 'main', b: next ? next.id : null, slot: null });
  };
}
async function certifySlot() {
  const c = S.cur; if (!c) return;
  const key = jobsKey() + '|' + c.req.uid + '|' + c.slot;
  const p = call('certify', { jobs: committedJobs(), req: c.req, t: c.slot, policy: policy() });
  S.certs.set(key, p); drawRight(c.req, c.a, c.slot);
  const r = await p; S.certs.set(key, r);
  if (S.cur && S.cur.slot === c.slot) drawRight(c.req, c.a, c.slot);
  toast(r.ub <= policy().eps ? `Certified: bound ${pct(r.ub, 2)}` : `Not certified: bound ${pct(r.ub, 2)}`);
}
function download(name, text, type) { const b = new Blob([text], { type }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 500); }
function exportCur() {
  const c = S.cur; if (!c) return;
  const csv = ['start_minute,start_local,design_breaches,design_runs,design_risk,deterministic_pick,certified'].concat(c.a.curve.map(x => `${x.t},${fmtT(x.t, true)},${x.k},${x.n},${x.p.toFixed(5)},${c.a.det.nominal === x.t ? 1 : 0},${c.a.chosen && c.a.chosen.t === x.t ? 1 : 0}`)).join('\n');
  download(`${c.req.id}-start-risk.csv`, csv, 'text/csv');
  download(`${c.req.id}-certificate.json`, JSON.stringify({ batch: c.req.id, policy: policy(), chosen: c.a.chosen, attempts: c.a.attempts, deterministic: c.a.det, generatedBy: 'Certified Start (unofficial demo)' }, null, 2), 'application/json');
  toast('Exported CSV and certificate JSON');
}
function resetDemo() { S.store = { commits: [], eps: null, log: [] }; save(); S.analysis.clear(); S.detail.clear(); S.certs.clear(); S.timeline.clear(); S.stats.clear(); toast('Demo state reset'); go({ tab: 'plan', view: 'main', b: null, slot: null }); }
function showKeys() {
  const dlg = $('#dlg');
  dlg.innerHTML = `<form method="dialog"><div class="dlg-h" id="dlgTitle">Keyboard shortcuts</div><div class="dlg-b keys">
    <span><kbd>J</kbd> <kbd>K</kbd></span><span>Next / previous request</span><span><kbd>←</kbd> <kbd>→</kbd></span><span>Previous / next candidate start</span>
    <span><kbd>C</kbd></span><span>Jump to certified slot</span><span><kbd>Enter</kbd></span><span>Commit selected start</span>
    <span><kbd>1</kbd> <kbd>2</kbd></span><span>Day 0 / Day 7 planner window</span><span><kbd>D</kbd></span><span>Why this risk (detail)</span>
    <span><kbd>E</kbd></span><span>Export risk curve + certificate</span><span><kbd>O</kbd> <kbd>M</kbd> <kbd>P</kbd> <kbd>R</kbd></span><span>ORDER / MGMT / PLAN / RUN INFO</span>
    <span><kbd>?</kbd></span><span>This help</span></div><div class="dlg-f"><button class="btn" value="ok">Close</button></div></form>`;
  dlg.onclose = null; dlg.showModal();
}

document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]'); if (act) { e.preventDefault(); const a = act.dataset.act;
    if (a === 'commit') commit(); else if (a === 'certify') certifySlot(); else if (a === 'detail') go({ view: 'detail' }); else if (a === 'export') exportCur(); else if (a === 'reset') resetDemo(); else if (a === 'exportlog') download('admission-log.json', JSON.stringify(S.store.log, null, 2), 'application/json'); return; }
  const w = e.target.closest('[data-win]'); if (w) { go({ win: w.dataset.win }, true); return; }
  const sl = e.target.closest('tr[data-slot]'); if (sl) { go({ slot: +sl.dataset.slot }); return; }
  const b = e.target.closest('[data-b]'); if (b) { go({ tab: 'plan', view: 'main', b: b.dataset.b, slot: null }); return; }
});
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input,select,textarea') || $('#dlg').open) return;
  if (e.key === 'Enter' && e.target.closest('li[data-b]')) { go({ tab: 'plan', view: 'main', b: e.target.closest('li[data-b]').dataset.b, slot: null }); return; }
  const k = e.key;
  if (k === '?') return showKeys();
  if (k === 'o') return go({ tab: 'order', view: 'main' }); if (k === 'm') return go({ tab: 'mgmt', view: 'main' }); if (k === 'p') return go({ tab: 'plan', view: 'main' }); if (k === 'r') return go({ tab: 'run', view: 'main' });
  if (S.route.tab !== 'plan') return;
  const p = pending(); const i = p.findIndex(r => r.id === S.route.b);
  if (k === 'j' && p.length) return go({ b: p[Math.min(p.length - 1, i + 1)].id, slot: null });
  if (k === 'k' && p.length) return go({ b: p[Math.max(0, i - 1)].id, slot: null });
  if (!S.cur) return;
  const c = S.cur.a.cands, j = c.indexOf(S.cur.slot);
  if (k === 'ArrowRight') { e.preventDefault(); return go({ slot: c[Math.min(c.length - 1, j + 1)] }, true); }
  if (k === 'ArrowLeft') { e.preventDefault(); return go({ slot: c[Math.max(0, j - 1)] }, true); }
  if (k === 'c' && S.cur.a.chosen) return go({ slot: S.cur.a.chosen.t });
  if (k === '1') return go({ win: 'd0' }, true); if (k === '2') return go({ win: 'd7' }, true);
  if (k === 'd') return go({ view: 'detail' }); if (k === 'e') return exportCur();
  if (k === 'Enter') return commit();
});
$('#kbdBtn').addEventListener('click', showKeys);
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.cur && S.route.tab === 'plan' && S.route.view === 'main') { drawRisk(S.cur.req, S.cur.a); drawGantt(S.cur.req, S.cur.slot); } }, 150); });

function showError(e) {
  console.error(e);
  $('#app').innerHTML = `<div class="err"><h3 style="margin:0 0 8px">Couldn't compute the plan</h3><div class="sub" style="margin-bottom:12px">${esc(e.message || e)}</div><button class="btn sec" onclick="location.reload()">Retry</button> <button class="btn sec" data-act="reset">Reset demo state</button></div>`;
}

async function render() {
  setTabs();
  if (!S.data) return;
  if (S.route.tab === 'plan') return S.route.view === 'detail' ? renderDetail() : renderPlan();
  S.cur = null;
  if (S.route.tab === 'order') return renderOrder();
  if (S.route.tab === 'mgmt') return renderMgmt();
  if (S.route.tab === 'run') return renderRun();
}

async function boot() {
  parseRoute(); setTabs(); icons(); load();
  try {
    const get = (f) => fetch('data/' + f).then(r => { if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); });
    const [cr, logs, plan, pre] = await Promise.all([get('cluster.json'), get('logs.json'), get('plan.json'), get('precomputed.json')]);
    S.data = { cluster: cr.cluster, recipe: cr.recipe, logs, plan, pre };
    await initWorker();
    if (S.store.commits.some(c => !plan.requests.find(r => r.uid === c.uid))) resetDemo();
    render();
  } catch (e) { showError(e); }
}
boot();
