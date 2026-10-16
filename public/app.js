import {
  decodeBytes, parseAdsCSV, parseWhatConvertsCSV, buildReport, filterReport, sumRows,
} from './core.js';

const $ = id => document.getElementById(id);
const state = { leads: [], adsCampaigns: [], adsKeywords: [], source: '', open: new Set(), allOpen: false };

// ---------- formatting ----------
const money = v => v === null || v === undefined ? '—'
  : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: v >= 100 ? 0 : 2 });
const num = v => v === null || v === undefined ? '—' : Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1);
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
  const [wc, c, k] = await Promise.all(
    ['whatconverts-leads.csv', 'google-ads-campaigns.csv', 'google-ads-keywords.csv']
      .map(f => fetch(`samples/${f}`).then(r => r.text())));
  state.leads = parseWhatConvertsCSV(wc);
  state.adsCampaigns = parseAdsCSV(c).rows;
  state.adsKeywords = parseAdsCSV(k).rows;
  state.source = 'sample data';
  render();
});

$('clearBtn').addEventListener('click', () => {
  Object.assign(state, { leads: [], adsCampaigns: [], adsKeywords: [], source: '' });
  state.open.clear();
  $('leadsCard').hidden = true;
  render();
});

const isoDaysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

$('syncBtn').addEventListener('click', async () => {
  if (!$('from').value) $('from').value = isoDaysAgo(30);
  if (!$('to').value) $('to').value = isoDaysAgo(0);
  const btn = $('syncBtn');
  btn.disabled = true; btn.textContent = 'Syncing…';
  try {
    const res = await fetch(`/api/sync?from=${$('from').value}&to=${$('to').value}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    for (const e of body.errors || []) message(e, 'error');
    if (body.leads) state.leads = body.leads;
    if (body.adsCampaigns) state.adsCampaigns = body.adsCampaigns;
    if (body.adsKeywords) state.adsKeywords = body.adsKeywords;
    state.source = `API sync ${$('from').value} → ${$('to').value}`;
    render();
  } catch (err) {
    message(`Sync failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Sync from APIs';
  }
});

fetch('/api/status').then(r => r.ok ? r.json() : null).then(s => {
  if (s && (s.whatconverts || s.googleAds)) {
    $('syncBtn').hidden = false;
    $('syncBtn').title = `WhatConverts: ${s.whatconverts ? 'on' : 'off'} · Google Ads: ${s.googleAds ? 'on' : 'off'}`;
  }
}).catch(() => {});

// ---------- rendering ----------
let current = { rows: [], report: null };

function render() {
  const options = {
    from: $('from').value, to: $('to').value,
    googleOnly: $('googleOnly').checked, excludeSpam: $('excludeSpam').checked,
  };
  const report = buildReport({ ...state, options });
  const rows = filterReport(report, { campaign: $('campaignQ').value, keyword: $('keywordQ').value });
  current = { rows, report };

  const datedAds = [...state.adsCampaigns, ...state.adsKeywords].some(r => r.date);
  $('dataStatus').textContent = state.source
    ? `Data: ${state.source} · ${state.leads.length.toLocaleString()} WhatConverts leads · ` +
      `${state.adsCampaigns.length.toLocaleString()} campaign rows · ${state.adsKeywords.length.toLocaleString()} keyword rows` +
      ((options.from || options.to) && (state.adsCampaigns.length || state.adsKeywords.length) && !datedAds
        ? ' · Note: the Google Ads export has no Day column, so the date filter only applies to leads.' : '')
    : '';

  renderKpis(sumRows(rows), report.unattributed);
  renderTable(rows);
}

function renderKpis(t, unattributed) {
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
  ].join('');
}

function cells(node) {
  const a = node.ads, w = node.wc, m = node.metrics;
  const gapCls = m.convGap > 0 ? 'pos' : m.convGap < 0 ? 'neg' : 'dim';
  const leadCell = w.leads ? `<a class="leads-link" data-leads>${w.leads}</a>` : '<span class="dim">0</span>';
  const ad = v => node.inAds === false ? '<span class="dim">—</span>' : v;
  return `
    <td>${ad(money(a.cost))}</td>
    <td>${ad(num(a.clicks))}</td>
    <td>${ad(num(a.conversions))}</td>
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

$('expandAll').addEventListener('click', () => {
  state.allOpen = !state.allOpen;
  if (!state.allOpen) state.open.clear();
  $('expandAll').textContent = state.allOpen ? 'Collapse all' : 'Expand all';
  renderTable(current.rows);
});

$('exportBtn').addEventListener('click', () => {
  const head = ['Campaign', 'Keyword', 'Match type', 'Spend', 'Impressions', 'Clicks', 'Ads conversions',
    'WC leads', 'Calls', 'Forms', 'Chat', 'Quotable', 'Cost per lead', 'Gap (WC - Ads)', 'Quote value', 'Sales value'];
  const line = (c, k) => {
    const n = k || c;
    return [c.name, k ? k.keyword : '', k ? k.matchTypes.join('/') : '', n.ads.cost.toFixed(2), n.ads.impressions,
      n.ads.clicks, n.ads.conversions, n.wc.leads, n.wc.phone, n.wc.form, n.wc.chat, n.wc.quotable,
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

render();
