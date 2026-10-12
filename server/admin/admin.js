// Dimts operator console. Uses the session from signing in to the Dimts web
// app on this origin; the server decides who is staff and logs every request.
const main = document.getElementById('main');
const tip = document.getElementById('tip');
// A passkey sign-in keeps its own 12-hour console session; a phone-code sign-in to the app also works.
const store = {
  get: key => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch {} },
};
let token = null;
let reasons = [];

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const int = value => Number(value ?? 0).toLocaleString('en-US');
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');
const usd = cents => `$${(Number(cents ?? 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const micros = value => usd(Number(value ?? 0) / 1e4);
const money = (minor, currency) => `${(Number(minor ?? 0) / 100).toFixed(2)} ${esc(String(currency).toUpperCase())}`;
const amount = minor => (Number(minor ?? 0) / 100).toFixed(2);
const day = iso => (iso ? new Date(iso).toISOString().slice(0, 10) : '—');
const when = iso => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) : '—');
const label = key => esc(String(key).replace(/_/g, ' '));

async function api(path, options = {}) {
  const response = await fetch(`/api/admin${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || body.error || `HTTP ${response.status}`), { status: response.status, code: body.error });
  return body;
}

function stop(message) {
  main.innerHTML = `<div class="panel"><p>${message}</p></div>`;
}

const tile = (name, value, sub = '') => `<div class="tile"><div class="label">${esc(name)}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
const table = (head, rows, numeric = []) => `<table><thead><tr>${head.map((h, i) => `<th class="${numeric.includes(i) ? 'n' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
  <tbody>${rows.length ? rows.map(r => `<tr>${r.map((c, i) => `<td class="${numeric.includes(i) ? 'n' : ''}">${c}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${head.length}" class="muted">None yet</td></tr>`}</tbody></table>`;
const card = (title, body) => `<div class="card"><h3>${esc(title)}</h3>${body}</div>`;
const kv = obj => table(['', 'Accounts'], Object.entries(obj ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => [label(k), int(v)]), [1]);

/** Single-series bar chart: one hue, thin bars, 2px gaps, hover tooltip on a full-height hit target. */
function bars(points, valueKey, unit) {
  const w = 600, h = 160, pad = 18, n = points.length || 1;
  const max = Math.max(1, ...points.map(p => p[valueKey]));
  const step = (w - 2) / n, bw = Math.max(1, step - 2);
  const marks = points.map((p, i) => {
    const bh = Math.max(p[valueKey] ? 2 : 0, ((h - pad - 4) * p[valueKey]) / max);
    const x = 1 + i * step, y = h - pad - bh;
    return `<rect class="hit" x="${x}" y="0" width="${step}" height="${h - pad}" data-tip="${esc(p.day)}: ${int(p[valueKey])} ${esc(unit)}"></rect>
      <rect class="bar" x="${x}" y="${y}" width="${bw}" height="${bh}" rx="${Math.min(2, bw / 2)}"></rect>`;
  }).join('');
  const first = points[0]?.day ?? '', last = points[points.length - 1]?.day ?? '';
  const total = points.reduce((sum, p) => sum + p[valueKey], 0);
  // Labels sit outside the stretched SVG so they never distort or collide with bars.
  return `<div class="chart-meta"><span>${int(total)} total</span><span>peak ${int(max)}</span></div>
    <svg class="chart" viewBox="0 0 ${w} ${h - pad + 1}" preserveAspectRatio="none" role="img" aria-label="${esc(unit)} per day: ${int(total)} total, peak ${int(max)}">
    <line class="axis" x1="0" x2="${w}" y1="${h - pad}" y2="${h - pad}"></line>${marks}</svg>
    <div class="chart-meta"><span>${esc(first)}</span><span>${esc(last)}</span></div>`;
}

document.addEventListener('mousemove', event => {
  const target = event.target.closest?.('[data-tip]');
  if (!target) { tip.hidden = true; return; }
  tip.textContent = target.getAttribute('data-tip');
  tip.hidden = false;
  tip.style.left = `${Math.min(event.clientX + 12, window.innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${event.clientY + 14}px`;
});

// The period every trend view uses; remembered per browser.
const RANGES = [7, 30, 90];
let range = RANGES.includes(Number(store.get('dimts.admin.range'))) ? Number(store.get('dimts.admin.range')) : 30;
const stamp = text => { document.getElementById('stamp').textContent = text; };

const STATUS_TEXT = { ok: ['✓', 'OK'], warn: ['!', 'Warning'], fail: ['✕', 'Action needed'], info: ['i', 'Info'] };
const statusPill = status => `<span class="status ${status}"><span aria-hidden="true">${STATUS_TEXT[status][0]}</span> ${STATUS_TEXT[status][1]}</span>`;

function kpiValue(k, value) {
  if (k.unit === 'usd_cents') return usd(value);
  if (k.unit === 'rate') return `${(value * 100).toFixed(1)}%`;
  return int(value);
}

/** "▲ 12% better than the previous 30 days": direction, size and judgement, never colour alone. */
function delta(k) {
  if (k.unit === 'rate') {
    const diff = (k.now - k.before) * 100;
    if (Math.abs(diff) < 0.05) return '<span class="delta flat">no change</span>';
    const good = k.better === 'down' ? diff < 0 : diff > 0;
    return `<span class="delta ${good ? 'good' : 'bad'}">${diff > 0 ? '▲' : '▼'} ${Math.abs(diff).toFixed(1)} pts · ${good ? 'better' : 'worse'}</span>`;
  }
  if (!k.before) return k.now ? '<span class="delta flat">new this period</span>' : '<span class="delta flat">no change</span>';
  const change = (k.now - k.before) / k.before;
  if (Math.abs(change) < 0.005) return '<span class="delta flat">no change</span>';
  const good = k.better === 'down' ? change < 0 : change > 0;
  return `<span class="delta ${good ? 'good' : 'bad'}">${change > 0 ? '▲' : '▼'} ${Math.abs(Math.round(change * 100))}% · ${good ? 'better' : 'worse'}</span>`;
}

async function showToday() {
  const t = await api(`/today?days=${range}`);
  stamp(`Updated ${when(t.generated_at)} UTC · auto-refresh`);
  const headline = { ok: 'All systems normal', warn: 'Running, with warnings', fail: 'Needs action now' }[t.status];
  main.innerHTML = `
    <div class="banner ${t.status}">${statusPill(t.status)} <strong>${headline}</strong>
      <span class="muted small">${t.attention.length ? `${t.attention.length} item${t.attention.length > 1 ? 's' : ''} below` : 'Nothing needs you right now.'}</span></div>
    ${t.attention.length ? `<h2>Needs attention</h2><div class="card">${t.attention.map(c => `<div class="check">
      ${statusPill(c.status)}<div><strong>${esc(c.title)}</strong><br><span class="small">${esc(c.detail ?? '')}</span></div>
      <div class="count">${esc(c.value)}</div>${c.action ? `<div class="act">${esc(c.action)}</div>` : ''}</div>`).join('')}</div>` : ''}
    <h2>What changed: last ${t.changes.days} days vs the ${t.changes.days} before</h2>
    <div class="tiles">${t.changes.kpis.map(k => tile(k.title, kpiValue(k, k.now), `${delta(k)}<br>before: ${kpiValue(k, k.before)}`)).join('')}</div>
    <h2>Service health</h2>
    <div class="tiles health">${t.health.map(c => tile(c.title, esc(c.value), statusPill(c.status))).join('')}</div>`;
}

let overviewCache = null;
async function getOverview() {
  if (!overviewCache || Date.now() - overviewCache.at > 60_000) overviewCache = { at: Date.now(), data: await api('/overview') };
  return overviewCache.data;
}

/** Horizontal funnel: each step's bar is its share of sign-ups; the weakest step is named, not just coloured. */
function funnelChart(f) {
  // Fixed proportions (the SVG is capped in CSS) so text stays readable at any window width.
  const top = Math.max(1, f.steps[0].n), w = 760, labelW = 180, barMax = 340, rowH = 34;
  const rows = f.steps.map((s, i) => {
    const bw = Math.max(s.n ? 3 : 0, barMax * s.n / top), y = i * rowH;
    const weakest = s.id === f.bottleneck;
    return `<text class="flabel" x="0" y="${y + 22}">${esc(s.title)}</text>
      <rect class="bar${weakest ? ' weak' : ''}" x="${labelW}" y="${y + 7}" width="${bw}" height="22" rx="3" data-tip="${esc(s.title)}: ${int(s.n)}"></rect>
      <text class="fvalue" x="${labelW + bw + 8}" y="${y + 22}">${int(s.n)}${s.from_previous == null ? '' : ` · ${Math.round(s.from_previous * 100)}% of previous step`}${weakest ? ' · biggest drop' : ''}</text>`;
  }).join('');
  return `<svg class="funnel" viewBox="0 0 ${w} ${f.steps.length * rowH}" role="img" aria-label="Sign-up funnel">${rows}</svg>
    <p class="muted small">Each step counts people who also passed every step before it. ${int(f.paying_any)} of these accounts pay in total.</p>`;
}

async function showGrowth() {
  const [o, { cohorts }, f] = await Promise.all([getOverview(), api('/cohorts'), api(`/funnel?days=${range}`)]);
  stamp(`Updated ${when(o.generated_at)} UTC`);
  main.innerHTML = `
    <h2>Customers</h2>
    <div class="tiles">
      ${tile('Active accounts', int(o.accounts.total), `${int(o.accounts.deleted)} deleted`)}
      ${tile('Monthly active (called)', int(o.active.calls.d30), `WAU ${int(o.active.calls.d7)} · DAU ${int(o.active.calls.d1)}`)}
      ${o.active.app.d30 || !o.active.calls.d30
        ? tile('Opened the app (30d)', int(o.active.app.d30), `stickiness ${pct(o.active.calls.d1, o.active.calls.d30)} DAU/MAU`)
        : tile('Opened the app (30d)', '—', 'tracked from the next app release')}
      ${tile('Activation (call in 7 days)', pct(o.activation.activated, o.activation.cohort), `${int(o.activation.cohort)} sign-ups · median ${int(o.activation.median_hours)}h to first call`)}
      ${tile('Trial → paid', pct(o.trial.converted_after_end, o.trial.ended), `${int(o.trial.active)} on trial now · ${int(o.trial.started)} started`)}
    </div>
    <h2>Where people drop off: accounts created in the last ${f.days} days</h2>
    <div class="card">${funnelChart(f)}</div>
    <div class="grid2">
      ${card('New sign-ups per day (90 days)', bars(o.signups_daily, 'n', 'sign-ups'))}
      ${card('Accounts by plan', kv(o.accounts.by_plan))}
      ${card('Accounts by market', kv(o.accounts.by_region))}
    </div>
    <h2>Retention: weekly sign-up cohorts, share with a connected call in each week</h2>
    <div class="card cohort">${cohortTable(cohorts)}</div>
    <h2>Feature adoption (active accounts)</h2>
    <div class="grid2">
      ${card('Features', table(['Feature', 'Accounts', 'Share'], [
        ['Business number', int(o.accounts.with_business_number), pct(o.accounts.with_business_number, o.accounts.total)],
        ['Own caller ID verified', int(o.adoption.caller_id), pct(o.adoption.caller_id, o.accounts.total)],
        ['Google Calendar', int(o.adoption.calendar), pct(o.adoption.calendar, o.accounts.total)],
        ['Gmail drafts', int(o.adoption.gmail), pct(o.adoption.gmail, o.accounts.total)],
        ['Push notifications', int(o.adoption.push), pct(o.adoption.push, o.accounts.total)],
        ['Amharic notes', int(o.adoption.amharic), pct(o.adoption.amharic, o.accounts.total)],
        ['On current terms', int(o.adoption.terms_current), pct(o.adoption.terms_current, o.accounts.total)]], [1, 2]))}
      ${card('Call retention chosen', table(['Keep calls', 'Accounts'], [
        ['3 months', int(o.adoption.keep_3)], ['6 months', int(o.adoption.keep_6)], ['12 months (default)', int(o.adoption.keep_12)],
        ['24 months', int(o.adoption.keep_24)], ['Until deleted', int(o.adoption.keep_forever)]], [1]))}
      ${card('Most active accounts (30 days)', table(['Account', 'Market', 'Plan', 'Calls', 'Minutes'],
        o.top_accounts.map(a => [`<code>${esc(a.id.slice(0, 8))}</code> ${esc(a.phone)}`, esc(a.region), esc(a.tier), int(a.calls), int(a.minutes)]), [3, 4]))}
    </div>`;
}

async function showRevenue() {
  const o = await getOverview();
  stamp(`Updated ${when(o.generated_at)} UTC · last 30 days`);
  const r = o.revenue, u = o.unit_economics;
  const paid = (o.accounts.by_plan.pro ?? 0) + (o.accounts.by_plan.business ?? 0);
  const cost = u.carrier_billed_micros_30d || u.estimated_call_cost_micros_30d;
  const margin = u.usd_net_revenue_cents_30d ? (u.usd_net_revenue_cents_30d - cost / 1e4) / u.usd_net_revenue_cents_30d : null;
  main.innerHTML = `
    <h2>Revenue (last 30 days)</h2>
    <div class="tiles">
      ${tile('MRR (list, USD)', usd(r.mrr_usd_cents), `ARPPU ${usd(r.arppu_usd_cents)}`)}
      ${tile('Paying customers', int(r.paying_users), `${int(paid)} on a paid tier`)}
      ${tile('Churn (30 days)', r.churn_rate_30d ? `${(r.churn_rate_30d * 100).toFixed(1)}%` : '0%', `${int(r.cancelling)} cancelling · ${int(r.past_due)} past due`)}
      ${tile('Gross margin (USD)', margin == null ? '—' : `${Math.round(margin * 100)}%`, `net ${usd(u.usd_net_revenue_cents_30d)} · cost ${micros(cost)}`)}
      ${tile('Credits outstanding', int(o.credits.outstanding), 'prepaid, owed as calls')}
    </div>
    <div class="grid2">
      ${card('Payments (Polar, before fees)', table(['Currency', 'Type', 'Orders', 'Gross', 'Tax', 'Refunded'],
        r.payments_30d.map(p => [esc(p.currency.toUpperCase()), p.credits ? 'credits' : 'plans', int(p.orders), amount(p.gross), amount(p.tax), amount(p.refunded)]), [2, 3, 4, 5]))}
      ${card('Active plans', kv(r.plans))}
      ${card('Credits (1 credit = 1¢)', table(['', 'Credits'], [
        ['Outstanding balance (liability)', int(o.credits.outstanding)], ['Bought, 30 days', int(o.credits.bought_30d)],
        ['Used on calls, 30 days', int(o.credits.used_30d)], ['Granted by staff, 30 days', int(o.credits.granted_30d)]], [1]))}
      ${card('Carrier cost by country (Telnyx bills)', table(['Country', 'Records', 'Minutes', 'Cost'],
        u.carrier_by_country.map(row => [row.country_code ? `+${esc(row.country_code)}` : '—', int(row.records), int(row.minutes), micros(row.micros)]), [1, 2, 3])
        + `<p class="muted small">Our per-call estimate: ${micros(u.estimated_call_cost_micros_30d)}. Fixed costs (Vercel, Supabase, AI plans) not included.</p>`)}
    </div>`;
}

async function showOperations() {
  const x = await api(`/operations?days=${range}`);
  stamp(`Updated ${when(x.generated_at)} UTC`);
  const c = x.outcomes;
  main.innerHTML = `
    <h2>Calls: last ${x.days} days</h2>
    <div class="tiles">
      ${tile('Calls', int(c.total), `${int(c.minutes)} minutes · avg ${Math.round(c.avg_sec / 6) / 10} min`)}
      ${tile('Connected', pct(c.connected, c.total), `${int(c.unanswered)} unanswered`)}
      ${tile('Notes delivered', pct(c.ready, c.connected), 'of connected calls')}
      ${tile('Our failure rate', pct(c.failed, c.total), `${int(c.failed)} failed after connecting`)}
      ${tile('Inbound share', pct(c.inbound, c.total), `${int(c.voicemails)} voicemails`)}
      ${tile('Amharic calls', int(c.amharic), pct(c.amharic, c.total))}
    </div>
    <div class="grid2">
      ${card('Our failures per day', bars(x.daily, 'failed', 'failed calls'))}
      ${card('Unanswered per day (busy, no answer, missed)', bars(x.daily, 'unanswered', 'unanswered calls'))}
      ${card('Why calls failed', table(['Reason', 'Calls'], x.failure_reasons.map(r => [esc(r.reason), int(r.n)]), [1])
        + '<p class="muted small">Grouped from error codes. The original messages are not shown: they can quote what a provider received.</p>')}
      ${card('Outbound calls by country called', table(['Country', 'Calls', 'Our failures', 'Unanswered'],
        x.by_destination.map(d => [d.country_code === 'other' ? 'Other' : `+${esc(d.country_code)}`, int(d.calls), pct(d.failed, d.calls), pct(d.unanswered, d.calls)]), [1, 2, 3]))}
    </div>
    <h2>Capacity and queues (now)</h2>
    <div class="tiles">
      ${tile('Calls live now', int(x.queue.live), 'ringing or connected')}
      ${tile('Notes being made', int(x.queue.processing), 'transcription and AI')}
      ${tile('Business numbers free', int(x.numbers.free), `${int(x.numbers.assigned)} assigned · ${int(x.numbers.total)} held`)}
      ${tile('Numbers cost', usd(x.numbers.monthly_cost_usd * 100), 'per month, about $1 each')}
      ${tile('Press-1 consent asked', int(x.consent.asked), `${int(x.consent.declined)} declined recording`)}
    </div>`;
}

function cohortTable(rows) {
  const width = Math.max(1, ...rows.map(r => r.weeks.length));
  const head = ['Week of', 'Sign-ups', ...Array.from({ length: width }, (_, k) => `W${k}`)];
  const body = rows.map(r => `<tr><td>${esc(r.week)}</td><td class="n">${int(r.size)}</td>${Array.from({ length: width }, (_, k) => {
    if (k >= r.weeks.length) return '<td class="c"></td>';
    const share = r.size ? r.weeks[k] / r.size : 0;
    const step = share === 0 ? 0 : Math.min(5, 1 + Math.floor(share * 5));
    return `<td class="c h${step}" data-tip="${esc(r.week)} · week ${k}: ${int(r.weeks[k])} of ${int(r.size)}">${r.size ? `${Math.round(share * 100)}%` : ''}</td>`;
  }).join('')}</tr>`).join('');
  return `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td class="muted" colspan="3">No sign-ups in these weeks</td></tr>`}</tbody></table>`;
}

const STATUS = { ok: ['✓', 'OK'], warn: ['!', 'Warning'], fail: ['✕', 'Action needed'], info: ['i', 'Info'] };

async function showCompliance() {
  const { checks, generated_at: at } = await api('/compliance');
  document.getElementById('stamp').textContent = `Checked ${when(at)} UTC`;
  const failing = checks.filter(c => c.status === 'fail').length;
  main.innerHTML = `<h2>Legal and privacy checks</h2>
    <p class="muted">Each line tests a promise from our privacy policy, terms or recording law against live data. ${failing ? `<strong class="err">${failing} need action.</strong>` : 'Nothing needs action.'}</p>
    <div class="card">${checks.map(c => `<div class="check">
      <span class="status ${c.status}"><span aria-hidden="true">${STATUS[c.status][0]}</span> ${STATUS[c.status][1]}</span>
      <div><strong>${esc(c.title)}</strong><br><span class="small">Rule: ${esc(c.rule)}</span></div>
      <div class="count">${int(c.count)}</div>
      <div class="meta">${esc(c.source)}</div>
      ${c.action ? `<div class="act">${esc(c.action)}</div>` : ''}
    </div>`).join('')}</div>
    <p class="muted small">Not checked here (outside the code): provider DPAs, lawyer review, Ethiopia and Germany/Austria counsel questions. See docs/legal/dpa-checklist.md.</p>`;
}

// Marketing-site waitlist: emails people gave to hear about the apps.
async function showWaitlist() {
  const w = await api('/waitlist');
  stamp(`Updated ${when(new Date().toISOString())} UTC`);
  // Fill in days with no sign-ups so the chart's gaps are real gaps.
  const counts = Object.fromEntries(w.days.map(d => [d.day, d.n]));
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10);
    return { day: d, n: counts[d] ?? 0 };
  });
  main.innerHTML = `<h2>Waitlist</h2>
    <p class="muted">People who joined from the website (dimts-site.vercel.app) to hear when the apps are out. The channel comes from the <code>?ref=</code> in the link they used.</p>
    <div class="tiles">${tile('On the list', int(w.total))}${tile('Last 7 days', int(w.last_7d))}${tile('Last 24 hours', int(w.last_24h))}</div>
    <div class="grid2">
      ${card('Sign-ups per day (30 days)', bars(days, 'n', 'sign-ups'))}
      ${card('Where they came from', table(['Channel', 'Sign-ups', 'Share'], w.channels.map(c => [esc(c.channel), int(c.n), pct(c.n, w.total)]), [1, 2]))}
      ${card('Phone', table(['Phone', 'Sign-ups'], w.platforms.map(p => [label(p.platform), int(p.n)]), [1]))}
    </div>
    <div class="card"><div class="row"><h3>Everyone, newest first</h3><button class="btn primary" id="csv"${w.people.length ? '' : ' disabled'}>Download CSV</button></div>
    ${table(['Joined (UTC)', 'Email', 'Phone', 'Country', 'Source'],
      w.people.map(p => [when(p.created_at), esc(p.email), esc(p.platform ?? ''), esc(p.country ?? ''), esc(p.source ?? '')]))}</div>`;
  document.getElementById('csv').onclick = () => {
    const cell = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = ['email,platform,work,country,source,joined',
      ...w.people.map(p => [p.email, p.platform, p.work, p.country, p.source, p.created_at].map(cell).join(','))].join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = `dimts-waitlist-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
}

const reasonSelect = id => `<select id="${id}"><option value="">Reason…</option>${reasons.map(r => `<option value="${esc(r)}">${label(r)}</option>`).join('')}</select>`;

async function showCustomers(state = { q: '', plan: '', page: 0 }) {
  main.innerHTML = `<h2>Customers</h2>
    <div class="toolbar">
      <input id="q" placeholder="Full number, last 4 digits or account ID" value="${esc(state.q)}" size="34">
      <select id="plan">${['', 'trial', 'free', 'pro', 'business', 'deleted'].map(p => `<option value="${p}" ${p === state.plan ? 'selected' : ''}>${p ? label(p) : 'All plans'}</option>`).join('')}</select>
      <button class="btn primary" id="go">Search</button>
    </div>
    <div id="detail"></div><div class="card" id="list"><p class="muted">Loading…</p></div>`;
  const run = () => showCustomers({ q: document.getElementById('q').value, plan: document.getElementById('plan').value, page: 0 });
  document.getElementById('go').onclick = run;
  document.getElementById('q').onkeydown = e => { if (e.key === 'Enter') run(); };
  const result = await api(`/customers?q=${encodeURIComponent(state.q)}&plan=${encodeURIComponent(state.plan)}&page=${state.page}`);
  const list = document.getElementById('list');
  list.innerHTML = table(['Account', 'Number', 'Market', 'Plan', 'Signed up', 'Last seen', 'Calls 30d', 'Min 30d', 'Credits', 'Subscription'],
    result.customers.map(c => [`<code>${esc(c.id.slice(0, 8))}</code>`, esc(c.phone), esc(c.region),
      c.deleted_at ? '<span class="pill">deleted</span>' : (c.tier === 'free' && c.trial_ends_at && new Date(c.trial_ends_at) > new Date() ? 'trial' : esc(c.tier)),
      day(c.created_at), day(c.last_seen_at), int(c.calls_30d), int(c.minutes_30d), int(c.credits), esc(c.subscription ?? '—')]), [6, 7, 8])
    + `<div class="row">${state.page ? '<button class="btn" id="prev">Previous</button>' : ''}${result.has_more ? '<button class="btn" id="next">Next</button>' : ''}
      <span class="muted small">Click a row to open an account. Opening is logged and shown to the customer.</span></div>`;
  [...list.querySelectorAll('tbody tr')].forEach((tr, i) => {
    const customer = result.customers[i];
    if (!customer) return;
    tr.classList.add('click');
    tr.onclick = () => askReason(customer);
  });
  document.getElementById('prev')?.addEventListener('click', () => showCustomers({ ...state, page: state.page - 1 }));
  document.getElementById('next')?.addEventListener('click', () => showCustomers({ ...state, page: state.page + 1 }));
}

function askReason(customer) {
  const detail = document.getElementById('detail');
  detail.innerHTML = `<div class="panel"><strong>Open account ${esc(customer.id.slice(0, 8))} (${esc(customer.phone)})</strong>
    <div class="row">${reasonSelect('open-reason')}<button class="btn primary" id="open">Open</button><button class="btn" id="cancel">Cancel</button></div>
    <p class="muted small">The customer will see “Dimts staff viewed your account” in their activity log.</p></div>`;
  document.getElementById('cancel').onclick = () => { detail.innerHTML = ''; };
  document.getElementById('open').onclick = () => {
    const reason = document.getElementById('open-reason').value;
    if (reason) openCustomer(customer.id, reason).catch(fail);
  };
  detail.scrollIntoView({ behavior: 'smooth' });
}

async function openCustomer(id, reason) {
  const c = await api(`/customers/${id}?reason=${encodeURIComponent(reason)}`);
  const detail = document.getElementById('detail');
  detail.innerHTML = `<div class="panel">
    <div class="row"><strong>Account <code>${esc(c.id)}</code></strong><button class="btn" id="close">Close</button></div>
    <div class="tiles">
      ${tile('Number', `<span id="phone">${esc(c.phone)}</span>`, esc(c.region))}
      ${tile('Plan', esc(c.tier), c.trial_ends_at ? `trial ends ${day(c.trial_ends_at)}` : '')}
      ${tile('Credits', int(c.credits.balance), '1 credit = 1¢')}
      ${tile('Signed up', day(c.created_at), c.deleted_at ? `deleted ${day(c.deleted_at)}` : `terms ${esc(c.terms_version ?? 'not accepted')}`)}
      ${tile('Devices', int(c.devices.sessions), `last seen ${day(c.devices.last_seen_at)}`)}
      ${tile('Privacy requests', int(c.privacy_requests.open), `${int(c.privacy_requests.total)} total`)}
    </div>
    <div class="row">${reasonSelect('act-reason')}
      <button class="btn" id="reveal" ${c.deleted_at ? 'disabled' : ''}>Reveal full number</button>
      <input id="credits" type="number" min="1" max="5000" placeholder="Credits" size="8">
      <button class="btn" id="grant" ${c.deleted_at ? 'disabled' : ''}>Grant credits</button>
      <span id="act-msg" class="small"></span></div>
    <div class="grid2">
      ${card('Usage by month', table(['Month', 'Calls', 'Inbound', 'Minutes', 'Est. cost'],
        c.usage_by_month.map(m => [esc(m.month), int(m.calls), int(m.inbound), int(m.minutes), micros(m.cost_micros)]), [1, 2, 3, 4]))}
      ${card('Call outcomes (90 days)', table(['Status', 'Calls'], c.calls_by_status_90d.map(s => [esc(s.status), int(s.n)]), [1]))}
      ${card('Subscriptions', table(['Product', 'Status', 'Period end', 'Cancelling'],
        c.subscriptions.map(s => [esc(s.product_key), esc(s.status), day(s.current_period_end), s.cancel_at_period_end ? 'yes' : 'no'])))}
      ${card('Payments', table(['Date', 'Product', 'Amount', 'Refunded'],
        c.payments.map(p => [day(p.paid_at), esc(p.product_key), money(p.total_amount, p.currency), money(p.refunded_amount, p.currency)]), [2, 3]))}
      ${card('Credit ledger', table(['Date', 'Reason', 'Credits'], c.credits.entries.map(e => [day(e.created_at), esc(e.reason), int(e.amount_cents)]), [2]))}
      ${card('Settings', table(['', ''], [['Business number', c.has_business_number ? 'yes' : 'no'], ['Own caller ID', c.caller_id_verified_at ? 'verified' : 'no'],
        ['Keeps calls', c.retention_months ? `${c.retention_months} months` : 'until deleted'], ['Notes language', esc(c.language)],
        ['Time zone', esc(c.timezone ?? '—')], ['Google', esc(c.google.map(g => g.kind).join(', ') || 'not connected')]]))}
      ${card('Account activity (security log)', table(['When', 'Action'], c.activity.map(a => [when(a.created_at), label(a.action)])))}
    </div></div>`;
  const msg = document.getElementById('act-msg');
  const actReason = () => {
    const value = document.getElementById('act-reason').value;
    if (!value) { msg.textContent = 'Choose a reason first.'; msg.className = 'small err'; }
    return value;
  };
  document.getElementById('close').onclick = () => { detail.innerHTML = ''; };
  document.getElementById('reveal').onclick = async () => {
    const why = actReason(); if (!why) return;
    try {
      const { phone } = await api(`/customers/${id}/reveal-phone`, { method: 'POST', body: JSON.stringify({ reason: why }) });
      document.getElementById('phone').textContent = phone;
      msg.textContent = 'Revealed and logged.'; msg.className = 'small';
    } catch (err) { msg.textContent = err.message; msg.className = 'small err'; }
  };
  document.getElementById('grant').onclick = async () => {
    const why = actReason(); if (!why) return;
    const credits = Number(document.getElementById('credits').value);
    try {
      const { balance } = await api(`/customers/${id}/credits`, { method: 'POST', body: JSON.stringify({ reason: why, credits }) });
      msg.textContent = `Granted. New balance ${int(balance)}.`; msg.className = 'small';
    } catch (err) { msg.textContent = err.message; msg.className = 'small err'; }
  };
}

async function showAccess() {
  const { events } = await api('/access-log');
  main.innerHTML = `<h2>Staff access log</h2>
    <p class="muted">Every console request, newest first. Kept for one year with the rest of the activity log.</p>
    <div class="card">${table(['When (UTC)', 'Staff', 'Action', 'Account', 'Reason'],
      events.map(e => [when(e.created_at), esc(e.staff), label(e.action.replace(/^admin_/, '')),
        e.target_id ? `<code>${esc(String(e.target_id).slice(0, 8))}</code>` : '', e.reason ? label(e.reason) : '']))}</div>`;
}

// WebAuthn speaks bytes; the server speaks base64url JSON.
const b64 = {
  enc: buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)), c => c.charCodeAt(0)),
};
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const passkeysWork = () => !!window.PublicKeyCredential && !!navigator.credentials;

/** Ask the device for a new passkey; returns it as the JSON the server verifies. */
async function newPasskey(options) {
  const credential = await navigator.credentials.create({ publicKey: {
    ...options,
    challenge: b64.dec(options.challenge),
    user: { ...options.user, id: b64.dec(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map(c => ({ ...c, id: b64.dec(c.id) })),
  } });
  return {
    id: credential.id, rawId: b64.enc(credential.rawId), type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: b64.enc(credential.response.clientDataJSON),
      attestationObject: b64.enc(credential.response.attestationObject),
      transports: credential.response.getTransports?.() ?? [],
    },
  };
}

async function addPasskey() {
  await post('/passkeys/register', await newPasskey(await post('/passkeys/register/options')));
}

/** The one-time setup link: first passkey and first sign-in in one step, no text or call. */
async function setupWithLink(setup) {
  const credential = await newPasskey(await post('/setup/options', { setup }));
  const { token: session } = await post('/setup', { setup, credential });
  store.set('dimts.admin', session);
  token = session;
}

function setupScreen(setup) {
  document.getElementById('tabs').hidden = true;
  document.getElementById('signout').hidden = true;
  document.getElementById('range').hidden = true;
  main.innerHTML = `<div class="signin">
    <h2>Set up your staff sign-in</h2>
    <p class="small">This one-time link adds Face ID or your fingerprint as your way into the console. No text message or call.</p>
    ${passkeysWork()
      ? '<button class="btn primary big" id="setup-go">Set up Face ID or fingerprint</button>'
      : '<p class="err">This browser cannot use passkeys. Open the link in a current Chrome, Safari, Edge or Firefox.</p>'}
    <p id="setup-msg" class="small muted"></p></div>`;
  document.getElementById('setup-go')?.addEventListener('click', async () => {
    const msg = document.getElementById('setup-msg');
    msg.textContent = 'Waiting for your device…'; msg.className = 'small muted';
    try { await setupWithLink(setup); await start(); } catch (err) {
      msg.textContent = err.status === 404 ? 'This setup link is not valid.' : err.name === 'NotAllowedError' ? 'Cancelled. Press the button to try again.' : err.message;
      msg.className = 'small err';
    }
  });
}

async function passkeySignIn() {
  const options = await post('/passkeys/login/options');
  const credential = await navigator.credentials.get({ publicKey: {
    ...options,
    challenge: b64.dec(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map(c => ({ ...c, id: b64.dec(c.id) })),
  } });
  const { token: session } = await post('/passkeys/login', {
    id: credential.id, rawId: b64.enc(credential.rawId), type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: b64.enc(credential.response.clientDataJSON),
      authenticatorData: b64.enc(credential.response.authenticatorData),
      signature: b64.enc(credential.response.signature),
      userHandle: credential.response.userHandle ? b64.enc(credential.response.userHandle) : undefined,
    },
  });
  store.set('dimts.admin', session);
  token = session;
}

function signInScreen(message = '') {
  document.getElementById('tabs').hidden = true;
  document.getElementById('signout').hidden = true;
  document.getElementById('range').hidden = true;
  main.innerHTML = `<div class="signin">
    <h2>Staff sign-in</h2>
    ${passkeysWork()
      ? '<button class="btn primary big" id="passkey">Sign in with Face ID or fingerprint</button>'
      : '<p class="err">This browser cannot use passkeys. Use a current Chrome, Safari, Edge or Firefox.</p>'}
    <p id="signin-msg" class="small ${message ? 'err' : 'muted'}">${esc(message)}</p>
    <details><summary>First time on this device?</summary>
      <ol class="small">
        <li>Sign in to the <a href="/">Dimts app</a> in this browser with your staff number (one text code, only this once).</li>
        <li>Come back to <code>/admin/</code> and press <strong>Set up Face ID or fingerprint</strong>.</li>
        <li>From then on, this button is all you need.</li>
      </ol></details>
  </div>`;
  document.getElementById('passkey')?.addEventListener('click', async () => {
    const msg = document.getElementById('signin-msg');
    msg.textContent = 'Waiting for your device…'; msg.className = 'small muted';
    try { await passkeySignIn(); await start(); } catch (err) {
      msg.textContent = err.name === 'NotAllowedError' ? 'Cancelled, or no console passkey on this device yet. See “First time on this device?”.' : err.message;
      msg.className = 'small err';
    }
  });
}

function setupBanner() {
  return `<div class="panel row" id="setup"><span><strong>Skip the text code next time.</strong> Set up Face ID or fingerprint for this console.</span>
    <button class="btn primary" id="add-passkey">Set up Face ID or fingerprint</button><span id="setup-msg" class="small"></span></div>`;
}

function fail(err) {
  if ([401, 403, 404].includes(err.status)) {
    const notStaff = err.status === 404 && token && token === store.get('dimts.session');
    return signInScreen(notStaff ? 'This number is not on the staff list.' : err.status === 403 ? err.message : '');
  }
  stop(`<span class="err">${esc(err.message)}</span>`);
}

const views = { today: showToday, growth: showGrowth, revenue: showRevenue, operations: showOperations,
  customers: () => showCustomers(), waitlist: showWaitlist, compliance: showCompliance, access: showAccess };
let current = 'today';
async function show(name) {
  current = name;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  // The period only matters on views that show trends.
  document.getElementById('range').hidden = !['today', 'growth', 'operations'].includes(name);
  main.innerHTML = '<p class="muted">Loading…</p>';
  try { await views[name](); } catch (err) { fail(err); }
}

/** Try the console session first, then the app's; whichever the server accepts wins. */
async function start() {
  // A setup link carries its secret after '#', which browsers never send; clear it from the address bar at once.
  const setup = new URLSearchParams(location.hash.slice(1)).get('setup');
  if (setup) {
    history.replaceState(null, '', location.pathname);
    return setupScreen(setup);
  }
  let me = null;
  for (const key of ['dimts.admin', 'dimts.session']) {
    token = store.get(key);
    if (!token) continue;
    try { me = await api('/me'); break; } catch (err) {
      if (key === 'dimts.admin') store.set('dimts.admin', null);
      else return fail(err);
    }
  }
  if (!me) return signInScreen();
  // Today is the screen left open on a desk: keep it current while visible.
  clearInterval(start.timer);
  start.timer = setInterval(() => { if (current === 'today' && document.visibilityState === 'visible' && token) showToday().catch(fail); }, 60_000);
  reasons = me.reasons;
  const tabs = document.getElementById('tabs');
  tabs.hidden = false;
  tabs.querySelectorAll('button').forEach(b => { b.onclick = () => show(b.dataset.tab); });
  const signout = document.getElementById('signout');
  signout.hidden = false;
  signout.onclick = () => { store.set('dimts.admin', null); token = null; clearInterval(start.timer); signInScreen(); };
  const picker = document.getElementById('range');
  picker.value = String(range);
  picker.onchange = () => { range = Number(picker.value); store.set('dimts.admin.range', String(range)); show(current); };
  await show('today');
  if (!me.passkeys.length && passkeysWork()) {
    main.insertAdjacentHTML('afterbegin', setupBanner());
    document.getElementById('add-passkey').onclick = async () => {
      const msg = document.getElementById('setup-msg');
      try {
        await addPasskey();
        document.getElementById('setup').innerHTML = '<span>Done. Next time, press <strong>Sign in with Face ID or fingerprint</strong>.</span>';
      } catch (err) { msg.textContent = err.name === 'NotAllowedError' ? 'Cancelled.' : err.message; msg.className = 'small err'; }
    };
  }
}

start();
