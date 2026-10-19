import {
  decodeBytes, parseAdsCSV, parseWhatConvertsCSV, buildReport, filterReport, sumRows,
  gaRecord, gscRecord, gaSiteTotals, organicQueries,
} from './core.js';

const $ = id => document.getElementById(id);
const state = {
  leads: [], adsCampaigns: [], adsKeywords: [], ga: [], gsc: [], source: '',
  open: new Set(), allOpen: false, organicAll: false,
  api: null, synced: null, // /api/status result; { from, to } of the last API sync
};

// ---------- formatting ----------
const money = v => v === null || v === undefined ? '—'
  : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: v >= 100 ? 0 : 2 });
const num = v => v === null || v === undefined ? '—' : Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1);
const pct = v => v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function message(text, kind = 'warn') {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.textContent = text;
  $('messages').append(div);
  setTimeout(() => div.remove(), 12000);
}

// ---------- data loading ----------
async function readFiles(input) {
  return Promise.all([...input.files].map(async f => ({ name: f.name, text: decodeBytes(await f.arrayBuffer()) })));
}

$('wcFile').addEventListener('change', async e => {
  const files = await readFiles(e.target);
  const leads = [];
  for (const f of files) {
    try { leads.push(...parseWhatConvertsCSV(f.text)); }
    catch (err) { message(`${f.name}: ${err.message}`, 'error'); }
  }
  if (leads.length) { state.leads = leads; state.source = 'CSV upload'; }
  e.target.value = '';
  render();
});

$('adsFile').addEventListener('change', async e => {
  const files = await readFiles(e.target);
  const camp = [], kw = [];
  for (const f of files) {
    try {
      const { kind, rows } = parseAdsCSV(f.text);
      (kind === 'keyword' ? kw : camp).push(...rows);
    } catch (err) { message(`${f.name}: ${err.message}`, 'error'); }
  }
  if (camp.length) state.adsCampaigns = camp;
  if (kw.length) state.adsKeywords = kw;
  if (camp.length || kw.length) state.source = 'CSV upload';
  e.target.value = '';
  render();
});

$('sampleBtn').addEventListener('click', async () => {
  const [wc, c, k, ga, gsc] = await Promise.all(
    ['whatconverts-leads.csv', 'google-ads-campaigns.csv', 'google-ads-keywords.csv', 'ga4-sessions.json', 'search-console-queries.json']
      .map(f => fetch(`samples/${f}`).then(r => r.text())));
  state.leads = parseWhatConvertsCSV(wc);
  state.adsCampaigns = parseAdsCSV(c).rows;
  state.adsKeywords = parseAdsCSV(k).rows;
  state.ga = JSON.parse(ga).map(gaRecord);
  state.gsc = JSON.parse(gsc).map(gscRecord);
  state.source = 'sample data';
  state.synced = null;
  render();
});

$('clearBtn').addEventListener('click', () => {
  Object.assign(state, { leads: [], adsCampaigns: [], adsKeywords: [], ga: [], gsc: [], source: '', synced: null });
  state.open.clear();
  $('leadsCard').hidden = true;
  render();
});

const isoDaysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const anyApi = () => !!state.api && ['whatconverts', 'googleAds', 'ga4', 'searchConsole'].some(k => state.api[k]);

async function sync({ fresh = false } = {}) {
  if (!$('from').value) $('from').value = isoDaysAgo(30);
  if (!$('to').value) $('to').value = isoDaysAgo(0);
  const from = $('from').value, to = $('to').value;
  const btn = $('syncBtn');
  btn.disabled = true; btn.textContent = 'Syncing…';
  try {
    const res = await fetch(`/api/sync?from=${from}&to=${to}${fresh ? '&fresh' : ''}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    for (const e of body.errors || []) message(e, 'error');
    for (const k of ['leads', 'adsCampaigns', 'adsKeywords', 'ga', 'gsc']) if (body[k]) state[k] = body[k];
    state.synced = { from, to };
    const at = body.syncedAt ? new Date(body.syncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    state.source = `live APIs, ${from} → ${to}${at ? ` (as of ${at})` : ''}`;
    render();
  } catch (err) {
    message(`Sync failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Refresh data';
  }
}

$('syncBtn').addEventListener('click', () => sync({ fresh: true }));

// When the dashboard is showing live data, widening the date range pulls the new range.
let resyncTimer;
for (const id of ['from', 'to']) {
  $(id).addEventListener('change', () => {
    const { from, to } = { from: $('from').value, to: $('to').value };
    if (!state.synced || !from || !to || (from >= state.synced.from && to <= state.synced.to)) return;
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => sync(), 600);
  });
}

// ---------- connections ----------

$('connectionsBtn').addEventListener('click', () => {
  $('connectionsCard').hidden = !$('connectionsCard').hidden;
  if (!$('connectionsCard').hidden) renderConnections(true);
});
$('closeConnections').addEventListener('click', () => { $('connectionsCard').hidden = true; });

async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    state.api = res.ok ? await res.json() : null;
  } catch { state.api = null; }
  $('syncBtn').hidden = !anyApi();
  return state.api;
}

let accounts = null; // GA4 properties / GSC sites for the pickers, fetched once per connect

async function renderConnections(loadAccounts = false) {
  const s = state.api;
  if (!s) {
    $('sources').innerHTML = '';
    $('googleSetup').innerHTML = '<p class="dim">The dashboard server is not reachable, so live connections are unavailable. CSV upload still works.</p>';
    return;
  }
  const g = s.google;
  const row = (name, on, detail) =>
    `<li><span class="dot ${on ? 'on' : ''}"></span><b>${name}</b><span class="dim">${detail}</span></li>`;
  $('sources').innerHTML = [
    row('WhatConverts', s.whatconverts, s.whatconverts ? 'Connected' : 'Add WHATCONVERTS_API_TOKEN and _SECRET to .env'),
    row('Google Ads', s.googleAds, s.googleAds ? 'Connected'
      : !g.connected ? 'Connect Google below'
      : `Add ${g.adsMissing.join(' and ')} to .env`),
    row('Google Analytics 4', s.ga4, s.ga4 ? `Property ${esc(g.ga4PropertyId)}` : g.connected ? 'Choose a property below' : 'Connect Google below'),
    row('Search Console', s.searchConsole, s.searchConsole ? esc(g.gscSiteUrl) : g.connected ? 'Choose a site below' : 'Connect Google below'),
  ].join('');

  if (!g.clientConfigured) {
    $('googleSetup').innerHTML = `<p>To connect Google Ads, Analytics and Search Console, add <code>GOOGLE_CLIENT_ID</code> and
      <code>GOOGLE_CLIENT_SECRET</code> to <code>.env</code> and restart the server. The README walks through it.</p>`;
    return;
  }
  if (!g.connected) {
    $('googleSetup').innerHTML = `<p>Sign in with a Google account that has access to the Ads account, the GA4 property and the Search Console site.</p>
      <a class="btn primary" href="/auth/google">Connect Google</a>`;
    return;
  }
  if (loadAccounts || !accounts) {
    $('googleSetup').innerHTML = '<p class="dim">Loading your Google Analytics properties and Search Console sites…</p>';
    try {
      const res = await fetch('/api/google/accounts');
      accounts = await res.json();
      if (!res.ok) throw new Error(accounts.error || res.statusText);
      for (const e of accounts.errors || []) message(e, 'error');
    } catch (err) {
      accounts = { ga4Properties: [], gscSites: [] };
      message(`Could not list Google accounts: ${err.message}`, 'error');
    }
  }
  const options = (items, selected, label) => {
    const list = items.some(i => i.id === selected) || !selected ? items : [{ id: selected, name: selected }, ...items];
    return `<option value="">${label}</option>` + list.map(i =>
      `<option value="${esc(i.id)}" ${i.id === selected ? 'selected' : ''}>${esc(i.name)}</option>`).join('');
  };
  $('googleSetup').innerHTML = `
    <p>Signed in to Google${g.email ? ` as <b>${esc(g.email)}</b>` : ''}.
      ${g.viaEnv ? '<span class="dim">(using the refresh token in .env)</span>' : '<button id="disconnectGoogle" class="btn small ghost">Disconnect</button>'}
      <a class="btn small ghost" href="/auth/google">Reconnect</a></p>
    <div class="pickers">
      <label>Google Analytics 4 property
        <select id="ga4Pick">${options(accounts.ga4Properties, g.ga4PropertyId, 'Not used')}</select></label>
      <label>Search Console site
        <select id="gscPick">${options(accounts.gscSites.map(u => ({ id: u, name: u })), g.gscSiteUrl, 'Not used')}</select></label>
      <button id="saveGoogle" class="btn primary">Save &amp; sync</button>
    </div>`;
  $('saveGoogle').addEventListener('click', async () => {
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ga4PropertyId: $('ga4Pick').value, gscSiteUrl: $('gscPick').value }),
    });
    if (!res.ok) return message(`Could not save: ${(await res.json().catch(() => ({}))).error || res.statusText}`, 'error');
    state.api = await res.json();
    $('syncBtn').hidden = !anyApi();
    renderConnections();
    if (anyApi()) sync({ fresh: true });
  });
  $('disconnectGoogle')?.addEventListener('click', async () => {
    if (!confirm('Disconnect Google? Ads, Analytics and Search Console will stop syncing until you connect again.')) return;
    const res = await fetch('/api/google/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (res.ok) state.api = await res.json();
    accounts = null;
    $('syncBtn').hidden = !anyApi();
    renderConnections();
  });
}

// ---------- rendering ----------
let current = { rows: [], report: null };

function render() {
  const options = {
    from: $('from').value, to: $('to').value,
    googleOnly: $('googleOnly').checked, excludeSpam: $('excludeSpam').checked,
  };
  const report = buildReport({ ...state, options });
  $('report').classList.toggle('no-ga', !state.ga.length);
  const rows = filterReport(report, { campaign: $('campaignQ').value, keyword: $('keywordQ').value });
  current = { rows, report };

  const datedAds = [...state.adsCampaigns, ...state.adsKeywords].some(r => r.date);
  $('dataStatus').textContent = state.source
    ? `Data: ${state.source} · ${state.leads.length.toLocaleString()} WhatConverts leads · ` +
      `${state.adsCampaigns.length.toLocaleString()} campaign rows · ${state.adsKeywords.length.toLocaleString()} keyword rows` +
      (state.ga.length ? ` · ${state.ga.length.toLocaleString()} GA4 rows` : '') +
      (state.gsc.length ? ` · ${state.gsc.length.toLocaleString()} Search Console rows` : '') +
      ((options.from || options.to) && (state.adsCampaigns.length || state.adsKeywords.length) && !datedAds
        ? ' · Note: the Google Ads export has no Day column, so the date filter only applies to leads.' : '')
    : '';

  const organic = state.gsc.length ? organicQueries({ ...state, options, keyword: $('keywordQ').value }) : null;
  renderKpis(sumRows(rows), report.unattributed, organic, options);
  renderTable(rows);
  renderOrganic(organic);
}

function renderKpis(t, unattributed, organic, options) {
  const kpi = (label, value, note = '') =>
    `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div>${note ? `<div class="note">${note}</div>` : ''}</div>`;
  const gap = t.metrics.convGap;
  $('kpis').innerHTML = [
    kpi('Ad spend', money(t.ads.cost), `${num(t.ads.clicks)} clicks`),
    kpi('Google Ads conversions', num(t.ads.conversions)),
    kpi('WhatConverts leads', num(t.wc.leads), `${t.wc.phone} calls · ${t.wc.form} forms · ${t.wc.chat} chat`),
    kpi('Quotable leads', num(t.wc.quotable), t.wc.leads ? `${Math.round(100 * t.wc.quotable / t.wc.leads)}% of leads` : ''),
    kpi('Cost / lead', money(t.metrics.costPerLead), `Cost / quotable: ${money(t.metrics.costPerQuotable)}`),
    kpi('Sales value', money(t.wc.salesValue), t.metrics.roas !== null ? `${t.metrics.roas.toFixed(2)}× ROAS` : ''),
    kpi('Leads vs. Ads conv.', `<span class="${gap > 0 ? 'pos' : gap < 0 ? 'neg' : ''}">${gap > 0 ? '+' : ''}${num(gap)}</span>`,
      unattributed ? `${unattributed} leads with no campaign` : 'WC leads − Ads conversions'),
    state.ga.length ? (() => {
      const site = gaSiteTotals(state.ga, options);
      return kpi('Website sessions (GA4)', num(site.sessions),
        `${num(site.keyEvents)} key events · ${num(t.ga.sessions)} from these campaigns`);
    })() : '',
    organic ? kpi('Organic clicks (Search Console)', num(organic.totals.clicks),
      `${num(organic.totals.impressions)} impr. · ${organic.totals.organicLeads} organic WC leads`) : '',
  ].join('');
}

function cells(node) {
  const a = node.ads, w = node.wc, m = node.metrics;
  const gapCls = m.convGap > 0 ? 'pos' : m.convGap < 0 ? 'neg' : 'dim';
  const leadCell = w.leads ? `<a class="leads-link" data-leads>${w.leads}</a>` : '<span class="dim">0</span>';
  const ad = v => node.inAds === false ? '<span class="dim">—</span>' : v;
  const ga = v => node.ga ? num(v) : '<span class="dim" title="GA4 reports by campaign, not keyword">—</span>';
  return `
    <td>${ad(money(a.cost))}</td>
    <td>${ad(num(a.clicks))}</td>
    <td class="ga">${ga(node.ga?.sessions)}</td>
    <td>${ad(num(a.conversions))}</td>
    <td class="ga">${ga(node.ga?.keyEvents)}</td>
    <td>${leadCell}</td>
    <td>${w.phone || '<span class="dim">0</span>'}</td>
    <td>${w.form || '<span class="dim">0</span>'}</td>
    <td>${w.chat || '<span class="dim">0</span>'}</td>
    <td>${w.quotable || '<span class="dim">0</span>'}</td>
    <td>${money(m.costPerLead)}</td>
    <td class="${gapCls}">${m.convGap > 0 ? '+' : ''}${m.convGap === null ? '—' : num(m.convGap)}</td>
    <td>${w.salesValue ? money(w.salesValue) : '<span class="dim">—</span>'}</td>`;
}

function renderTable(rows) {
  const hasData = state.leads.length || state.adsCampaigns.length || state.adsKeywords.length;
  $('empty').hidden = !!hasData && rows.length > 0;
  if (hasData && !rows.length) $('empty').textContent = 'No campaigns match your search.';
  const tbody = $('report').querySelector('tbody');
  const hasAds = state.adsCampaigns.length || state.adsKeywords.length;
  const forceOpen = state.allOpen || !!$('keywordQ').value.trim();
  const html = [];
  rows.forEach((c, ci) => {
    const open = forceOpen || state.open.has(c.key);
    const tags = [
      hasAds && !c.inAds ? '<span class="tag warn" title="WhatConverts recorded leads for this campaign name, but it was not found in the Google Ads data">not in Google Ads</span>' : '',
      c.inAds && !c.wc.leads ? '<span class="tag">no WC leads</span>' : '',
    ].join('');
    html.push(`<tr class="campaign ${open ? 'open' : ''}" data-c="${ci}">
      <td class="name"><span class="caret">▸</span>${esc(c.name)}${tags}</td>${cells(c)}</tr>`);
    if (open) {
      c.keywords.forEach((k, ki) => {
        const meta = [k.matchTypes.join('/'), k.adGroups.join(', ')].filter(Boolean).join(' · ');
        const terms = k.searchTerms.length
          ? ` <span class="tag" title="Leads from these search terms are counted here:\n${esc(k.searchTerms.join('\n'))}">+${k.searchTerms.length} search term${k.searchTerms.length > 1 ? 's' : ''}</span>` : '';
        const kwTag = hasAds && state.adsKeywords.length && !k.inAds && k.key !== '(no keyword)'
          ? '<span class="tag warn" title="Keyword captured by WhatConverts that does not match any bidded keyword in this campaign">not in Google Ads</span>' : '';
        html.push(`<tr class="keyword" data-c="${ci}" data-k="${ki}">
          <td class="name"><span class="kw">${esc(k.keyword)}</span>${kwTag}${meta ? ` <span class="dim">· ${esc(meta)}</span>` : ''}${terms}</td>${cells(k)}</tr>`);
      });
    }
  });
  tbody.innerHTML = html.join('');
}

$('report').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-c]');
  if (!tr) return;
  const c = current.rows[Number(tr.dataset.c)];
  if (e.target.closest('[data-leads]')) {
    const node = tr.dataset.k !== undefined ? c.keywords[Number(tr.dataset.k)] : c;
    const title = tr.dataset.k !== undefined ? `${c.name} › ${node.keyword}` : c.name;
    return showLeads(title, node.wc.items);
  }
  if (tr.classList.contains('campaign')) {
    state.open.has(c.key) ? state.open.delete(c.key) : state.open.add(c.key);
    renderTable(current.rows);
  }
});

function showLeads(title, items) {
  $('leadsTitle').textContent = `Leads — ${title} (${items.length})`;
  const sorted = [...items].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  $('leads').querySelector('tbody').innerHTML = sorted.map(l => `<tr>
    <td>${esc(l.date || '')}</td>
    <td>${esc(l.type)}</td>
    <td>${esc([l.name, l.phone, l.email].filter(Boolean).join(' · '))}</td>
    <td>${esc(l.campaign)}</td>
    <td>${esc(l.keyword)}</td>
    <td>${esc([l.source, l.medium].filter(Boolean).join(' / '))}</td>
    <td>${esc(l.status)}</td>
    <td>${esc(l.quotableRaw)}</td>
    <td>${l.salesValue ? money(l.salesValue) : ''}</td></tr>`).join('');
  $('leadsCard').hidden = false;
  $('leadsCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('closeLeads').addEventListener('click', () => { $('leadsCard').hidden = true; });

const ORGANIC_ROWS = 50;
function renderOrganic(organic) {
  $('organicCard').hidden = !organic;
  if (!organic) return;
  const rows = state.organicAll ? organic.rows : organic.rows.slice(0, ORGANIC_ROWS);
  $('organicMore').hidden = organic.rows.length <= ORGANIC_ROWS;
  $('organicMore').textContent = state.organicAll ? `Top ${ORGANIC_ROWS}` : `Show all ${organic.rows.length.toLocaleString()}`;
  $('organicEmpty').hidden = rows.length > 0;
  $('organic').querySelector('tbody').innerHTML = rows.map(q => `<tr>
    <td class="name">${esc(q.query)}${q.paid ? ' <span class="tag" title="You also bid on this exact keyword in Google Ads">also in Ads</span>' : ''}</td>
    <td>${num(q.clicks)}</td>
    <td>${num(q.impressions)}</td>
    <td>${pct(q.ctr)}</td>
    <td>${q.position === null ? '—' : q.position.toFixed(1)}</td>
    <td>${q.paid ? money(q.paid.cost) : '<span class="dim">—</span>'}</td>
    <td>${q.paid ? num(q.paid.clicks) : '<span class="dim">—</span>'}</td></tr>`).join('');
}
$('organicMore').addEventListener('click', () => { state.organicAll = !state.organicAll; render(); });

$('expandAll').addEventListener('click', () => {
  state.allOpen = !state.allOpen;
  if (!state.allOpen) state.open.clear();
  $('expandAll').textContent = state.allOpen ? 'Collapse all' : 'Expand all';
  renderTable(current.rows);
});

$('exportBtn').addEventListener('click', () => {
  const head = ['Campaign', 'Keyword', 'Match type', 'Spend', 'Impressions', 'Clicks', 'GA sessions', 'Ads conversions', 'GA key events',
    'WC leads', 'Calls', 'Forms', 'Chat', 'Quotable', 'Cost per lead', 'Gap (WC - Ads)', 'Quote value', 'Sales value'];
  const line = (c, k) => {
    const n = k || c;
    return [c.name, k ? k.keyword : '', k ? k.matchTypes.join('/') : '', n.ads.cost.toFixed(2), n.ads.impressions,
      n.ads.clicks, n.ga ? n.ga.sessions : '', n.ads.conversions, n.ga ? n.ga.keyEvents : '', n.wc.leads, n.wc.phone, n.wc.form, n.wc.chat, n.wc.quotable,
      n.metrics.costPerLead === null ? '' : n.metrics.costPerLead.toFixed(2), n.metrics.convGap,
      n.wc.quoteValue.toFixed(2), n.wc.salesValue.toFixed(2)];
  };
  const out = [head];
  for (const c of current.rows) { out.push(line(c)); for (const k of c.keywords) out.push(line(c, k)); }
  const csv = out.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `campaign-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

for (const id of ['campaignQ', 'keywordQ']) $(id).addEventListener('input', render);
for (const id of ['from', 'to', 'googleOnly', 'excludeSpam']) $(id).addEventListener('change', render);

// Show live data straight away when any API is connected; otherwise point to setup.
(async () => {
  render();
  const params = new URLSearchParams(location.search);
  const googleResult = params.get('google');
  if (googleResult) history.replaceState(null, '', location.pathname);
  const s = await loadStatus();
  if (googleResult) {
    message(googleResult === 'connected' ? 'Google connected. Pick your Analytics property and Search Console site.' : googleResult,
      googleResult === 'connected' ? 'ok' : 'error');
  }
  if (googleResult || (s && !anyApi())) {
    $('connectionsCard').hidden = false;
    renderConnections(true);
  }
  if (anyApi()) sync();
})();
