// Shared data logic: parsing exports, normalizing records, and joining
// WhatConverts leads to Google Ads campaigns/keywords, plus GA4 sessions,
// Search Console queries and Google Business Profile activity.
// Used by the browser (app.js) and by the server (server.js) and tests.

// ---------- CSV ----------

export function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLines = text.split(/\r?\n/).slice(0, 10).join('\n');
  const tabs = (firstLines.match(/\t/g) || []).length;
  const commas = (firstLines.match(/,/g) || []).length;
  const delim = tabs > commas ? '\t' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

// Decode an uploaded file's bytes (Google Ads "Excel CSV" exports are UTF-16).
export function decodeBytes(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  return new TextDecoder('utf-8').decode(b);
}

const headerKey = h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

function pick(map, aliases) {
  for (const a of aliases) if (map[a] !== undefined) return map[a];
  return undefined;
}

export function parseNumber(v) {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/[$,%\s]/g, '').replace(/^--$/, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

export function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// ---------- Normalization used for matching ----------

export function normCampaign(s) {
  if (s === undefined || s === null) return '';
  let v = String(s);
  try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { v = v.replace(/\+/g, ' '); }
  return v.toLowerCase().replace(/[_\s]+/g, ' ').trim();
}

export function normKeyword(s) {
  if (s === undefined || s === null) return '';
  let v = String(s);
  try { v = decodeURIComponent(v.replace(/%(?![0-9a-f]{2})/gi, '%25')); } catch { /* keep raw */ }
  return v
    .toLowerCase()
    .replace(/^[\[\"]+|[\]\"]+$/g, '') // [exact] / "phrase"
    .replace(/(^|\s)\+/g, '$1')        // +broad +modifier
    .replace(/\s+/g, ' ')
    .trim();
}

const EMPTY = new Set(['', '(not set)', 'not set', '(none)', 'none', 'n/a', '--', 'null', 'undefined']);
const isEmpty = v => EMPTY.has(String(v ?? '').trim().toLowerCase());

// ---------- Google Ads ----------

const ADS_COLS = {
  campaign: ['campaign', 'campaignname'],
  campaignId: ['campaignid'],
  adGroup: ['adgroup', 'adgroupname'],
  keyword: ['keyword', 'searchkeyword', 'keywordtext'],
  matchType: ['matchtype', 'searchkeywordmatchtype', 'keywordmatchtype'],
  date: ['day', 'date'],
  impressions: ['impr', 'impressions'],
  clicks: ['clicks'],
  cost: ['cost', 'costusd', 'spend', 'amountspent'],
  conversions: ['conversions', 'conv'],
  convValue: ['convvalue', 'conversionvalue', 'conversionsvalue', 'totalconvvalue'],
};

function findHeaderRow(rows, required) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const keys = rows[i].map(headerKey);
    if (required.some(r => keys.includes(r))) return i;
  }
  return -1;
}

function indexHeaders(header, cols) {
  const keys = header.map(headerKey);
  const out = {};
  for (const [field, aliases] of Object.entries(cols)) {
    for (const a of aliases) {
      const idx = keys.indexOf(a);
      if (idx !== -1) { out[field] = idx; break; }
    }
  }
  return out;
}

// Returns { kind: 'campaign'|'keyword', rows: [...] }
export function parseAdsCSV(text) {
  const rows = parseCSV(text);
  const h = findHeaderRow(rows, ['campaign', 'campaignname']);
  if (h === -1) throw new Error('Could not find a "Campaign" column. Export a Campaigns or Keywords report from Google Ads.');
  const idx = indexHeaders(rows[h], ADS_COLS);
  const kind = idx.keyword !== undefined ? 'keyword' : 'campaign';
  const out = [];
  for (const r of rows.slice(h + 1)) {
    const first = (r[0] || '').trim().toLowerCase();
    if (first.startsWith('total')) continue;
    const get = f => (idx[f] === undefined ? undefined : r[idx[f]]);
    const campaign = (get('campaign') || '').trim();
    if (!campaign || campaign.toLowerCase().startsWith('total')) continue;
    out.push(adsRecord({
      campaign,
      campaignId: get('campaignId'),
      adGroup: get('adGroup'),
      keyword: get('keyword'),
      matchType: get('matchType'),
      date: get('date'),
      impressions: get('impressions'),
      clicks: get('clicks'),
      cost: get('cost'),
      conversions: get('conversions'),
      convValue: get('convValue'),
    }));
  }
  return { kind, rows: out };
}

export function adsRecord(o) {
  return {
    campaign: String(o.campaign || '').trim(),
    campaignId: o.campaignId ? String(o.campaignId).trim() : '',
    adGroup: o.adGroup ? String(o.adGroup).trim() : '',
    keyword: o.keyword ? String(o.keyword).trim() : '',
    matchType: o.matchType ? String(o.matchType).trim() : '',
    date: parseDate(o.date),
    impressions: parseNumber(o.impressions),
    clicks: parseNumber(o.clicks),
    cost: parseNumber(o.cost),
    conversions: parseNumber(o.conversions),
    convValue: parseNumber(o.convValue),
  };
}

// ---------- Google Analytics 4 / Search Console ----------

// One GA4 row per date × source × medium × session campaign.
export function gaRecord(o) {
  return {
    date: parseDate(o.date),
    source: String(o.source || '').trim(),
    medium: String(o.medium || '').trim(),
    campaign: isEmpty(o.campaign) ? '' : String(o.campaign).trim(),
    sessions: parseNumber(o.sessions),
    engagedSessions: parseNumber(o.engagedSessions),
    keyEvents: parseNumber(o.keyEvents),
  };
}

// One Search Console row per date × query.
export function gscRecord(o) {
  return {
    date: parseDate(o.date),
    query: String(o.query || '').trim(),
    clicks: parseNumber(o.clicks),
    impressions: parseNumber(o.impressions),
    position: parseNumber(o.position),
  };
}

// One Business Profile row per date × location.
export function gbpRecord(o) {
  return {
    date: parseDate(o.date),
    locationId: String(o.locationId || '').trim(),
    location: String(o.location || o.locationId || '').trim(),
    impressions: parseNumber(o.impressions),
    calls: parseNumber(o.calls),
    websiteClicks: parseNumber(o.websiteClicks),
    directions: parseNumber(o.directions),
  };
}

// ---------- WhatConverts ----------

const WC_FIELDS = {
  id: ['leadid', 'id'],
  date: ['datecreated', 'date', 'created', 'createdat', 'leaddate'],
  type: ['leadtype', 'type'],
  status: ['leadstatus', 'status'],
  source: ['leadsource', 'source', 'utmsource'],
  medium: ['leadmedium', 'medium', 'utmmedium'],
  campaign: ['leadcampaign', 'campaign', 'utmcampaign', 'campaignname'],
  keyword: ['leadkeyword', 'keyword', 'utmterm', 'paidkeyword', 'searchkeyword'],
  gclid: ['gclid', 'googleclickid'],
  quotable: ['quotable'],
  quoteValue: ['quotevalue'],
  salesValue: ['salesvalue', 'salevalue', 'revenue'],
  spam: ['spam', 'isspam'],
  duplicate: ['duplicate', 'isduplicate'],
  name: ['contactname', 'name', 'callername', 'fullname'],
  phone: ['phonenumber', 'callernumber', 'contactphonenumber'],
  email: ['emailaddress', 'contactemailaddress', 'email'],
  landingUrl: ['landingurl', 'leadurl'],
};

const truthy = v => /^(1|true|yes|y)$/i.test(String(v ?? '').trim());

// Accepts an object keyed by any header/field naming (CSV export or API JSON).
export function wcRecord(raw) {
  const map = {};
  for (const [k, v] of Object.entries(raw)) map[headerKey(k)] = v;
  const g = f => pick(map, WC_FIELDS[f]);
  const quotable = String(g('quotable') ?? '').trim();
  return {
    id: String(g('id') ?? ''),
    date: parseDate(g('date')),
    type: String(g('type') ?? '').trim() || 'Unknown',
    status: String(g('status') ?? '').trim(),
    source: String(g('source') ?? '').trim(),
    medium: String(g('medium') ?? '').trim(),
    campaign: isEmpty(g('campaign')) ? '' : String(g('campaign')).trim(),
    keyword: isEmpty(g('keyword')) ? '' : String(g('keyword')).trim(),
    gclid: isEmpty(g('gclid')) ? '' : String(g('gclid')).trim(),
    quotable: /^yes$/i.test(quotable) || quotable === '1' || quotable === 'true',
    quotableRaw: quotable,
    quoteValue: parseNumber(g('quoteValue')),
    salesValue: parseNumber(g('salesValue')),
    spam: truthy(g('spam')),
    duplicate: truthy(g('duplicate')),
    name: String(g('name') ?? '').trim(),
    phone: String(g('phone') ?? '').trim(),
    email: String(g('email') ?? '').trim(),
    landingUrl: String(g('landingUrl') ?? '').trim(),
  };
}

export function parseWhatConvertsCSV(text) {
  const rows = parseCSV(text);
  const h = findHeaderRow(rows, ['leadid', 'leadtype', 'leadsource', 'leadcampaign', 'datecreated']);
  if (h === -1) throw new Error('This does not look like a WhatConverts leads export (no "Lead Type"/"Lead Source" columns).');
  const header = rows[h];
  return rows.slice(h + 1).map(r => {
    const o = {};
    header.forEach((col, i) => { o[col] = r[i]; });
    return wcRecord(o);
  });
}

const isGooglePaid = (source, medium) =>
  source.toLowerCase().includes('google') && /^(cpc|ppc|paid|paid search|paidsearch|paid_search|sem)$/.test(medium.toLowerCase());

// Is this lead from Google Ads paid search?
export function isGoogleAdsLead(lead) {
  return !!lead.gclid || isGooglePaid(lead.source, lead.medium);
}

// Leads from the Business Profile: WhatConverts' GBP integration, or the usual
// UTM tags on the profile's website link (utm_campaign=gmb, utm_medium=gbp, ...).
export const isBusinessProfileLead = lead =>
  !lead.gclid && /\b(gmb|gbp|google my business|google business profile|business profile|google maps|maps)\b/i
    .test(`${lead.source} ${lead.medium} ${lead.campaign}`);

export const isGoogleOrganicLead = lead =>
  !lead.gclid && !isBusinessProfileLead(lead) &&
  lead.source.toLowerCase().includes('google') && lead.medium.toLowerCase() === 'organic';

// ---------- Join ----------

const emptyAds = () => ({ impressions: 0, clicks: 0, cost: 0, conversions: 0, convValue: 0 });
const emptyGa = () => ({ sessions: 0, engagedSessions: 0, keyEvents: 0 });
const emptyWc = () => ({ leads: 0, phone: 0, form: 0, chat: 0, other: 0, quotable: 0, quoteValue: 0, salesValue: 0, items: [] });

function addAds(t, r) {
  t.impressions += r.impressions; t.clicks += r.clicks; t.cost += r.cost;
  t.conversions += r.conversions; t.convValue += r.convValue;
}

function addGa(t, r) {
  t.sessions += r.sessions; t.engagedSessions += r.engagedSessions; t.keyEvents += r.keyEvents;
}

function addWc(t, l) {
  t.leads++;
  const type = l.type.toLowerCase();
  if (type.includes('call') || type.includes('phone') || type.includes('text')) t.phone++;
  else if (type.includes('form') || type.includes('email')) t.form++;
  else if (type.includes('chat')) t.chat++;
  else t.other++;
  if (l.quotable) t.quotable++;
  t.quoteValue += l.quoteValue;
  t.salesValue += l.salesValue;
  t.items.push(l);
}

function finish(node) {
  const a = node.ads, w = node.wc;
  // Rows that exist only in WhatConverts have no spend to compare against.
  const noAds = node.inAds === false;
  node.metrics = {
    ctr: a.impressions ? a.clicks / a.impressions : null,
    cpc: a.clicks ? a.cost / a.clicks : null,
    costPerLead: w.leads && !noAds ? a.cost / w.leads : null,
    costPerQuotable: w.quotable && !noAds ? a.cost / w.quotable : null,
    leadRate: a.clicks ? w.leads / a.clicks : null,
    roas: a.cost ? w.salesValue / a.cost : null,
    convGap: noAds ? null : w.leads - a.conversions,
  };
  return node;
}

export const inRange =(date, from, to) =>
  !date || ((!from || date >= from) && (!to || date <= to));

/**
 * Cross-reference WhatConverts leads with Google Ads data.
 * @param {object} p
 * @param {Array} p.adsCampaigns  campaign-level ads rows
 * @param {Array} p.adsKeywords   keyword-level ads rows
 * @param {Array} p.leads         WhatConverts lead records (wcRecord)
 * @param {Array} p.ga            GA4 session rows (gaRecord), joined by campaign name
 * @param {object} p.options      { from, to, googleOnly, excludeSpam }
 * @returns {{ campaigns: Array, totals: object, unattributed: number }}
 */
export function buildReport({ adsCampaigns = [], adsKeywords = [], leads = [], ga = [], options = {} }) {
  const { from = '', to = '', googleOnly = true, excludeSpam = true } = options;
  const campaigns = new Map();
  const idToKey = new Map();

  const getCampaign = (name, inAds) => {
    const key = normCampaign(name) || '(no campaign)';
    if (!campaigns.has(key)) {
      campaigns.set(key, {
        key, name: name || '(no campaign)', inAds: false,
        ads: emptyAds(), wc: emptyWc(), ga: emptyGa(), keywords: new Map(),
      });
    }
    const c = campaigns.get(key);
    if (inAds) c.inAds = true;
    return c;
  };

  const getKeyword = (c, text, matchType, adGroup) => {
    const key = normKeyword(text) || '(no keyword)';
    if (!c.keywords.has(key)) {
      c.keywords.set(key, {
        key, keyword: text ? normKeyword(text) : '(no keyword)',
        matchTypes: new Set(), adGroups: new Set(), searchTerms: new Set(), inAds: false,
        ads: emptyAds(), wc: emptyWc(),
      });
    }
    const k = c.keywords.get(key);
    if (matchType) k.matchTypes.add(matchType);
    if (adGroup) k.adGroups.add(adGroup);
    return k;
  };

  // WhatConverts often records the search term ("car accident lawyer cost"), not
  // the bidded keyword. Fall back to the longest bidded keyword in the same
  // campaign whose words all appear in the search term.
  const matchKeyword = (c, text) => {
    const key = normKeyword(text);
    const exact = key && c.keywords.get(key);
    if (exact || !key) return exact || getKeyword(c, text);
    const words = new Set(key.split(' '));
    let best = null, bestLen = 0;
    for (const k of c.keywords.values()) {
      if (!k.inAds) continue;
      const kw = k.key.split(' ');
      if (kw.length > bestLen && kw.every(w => words.has(w))) { best = k; bestLen = kw.length; }
    }
    if (!best) return getKeyword(c, text);
    best.searchTerms.add(key);
    return best;
  };

  for (const r of [...adsCampaigns, ...adsKeywords]) {
    if (r.campaignId) idToKey.set(r.campaignId, r.campaign);
  }

  const campaignRowsHaveData = adsCampaigns.length > 0;
  for (const r of adsCampaigns) {
    if (!inRange(r.date, from, to)) continue;
    addAds(getCampaign(r.campaign, true).ads, r);
  }
  for (const r of adsKeywords) {
    if (!inRange(r.date, from, to)) continue;
    const c = getCampaign(r.campaign, true);
    if (!campaignRowsHaveData) addAds(c.ads, r);
    const k = getKeyword(c, r.keyword, r.matchType, r.adGroup);
    k.inAds = true;
    addAds(k.ads, r);
  }

  let unattributed = 0;
  for (const l of leads) {
    if (excludeSpam && (l.spam || l.duplicate)) continue;
    if (!inRange(l.date, from, to)) continue;
    if (googleOnly && !isGoogleAdsLead(l)) continue;
    // utm_campaign is often set to {campaignid}; map it back to the name.
    const campaignName = idToKey.get(l.campaign) || l.campaign;
    if (!campaignName) unattributed++;
    const c = getCampaign(campaignName, false);
    addWc(c.wc, l);
    addWc(matchKeyword(c, l.keyword).wc, l);
  }

  // GA4 sessions attach to campaigns already known from Ads or WhatConverts;
  // GA-only campaign names (newsletters, referrals) would just add noise.
  for (const r of ga) {
    if (!inRange(r.date, from, to)) continue;
    if (googleOnly && !isGooglePaid(r.source, r.medium)) continue;
    const c = campaigns.get(normCampaign(idToKey.get(r.campaign) || r.campaign));
    if (c) addGa(c.ga, r);
  }

  const out = [...campaigns.values()].map(c => {
    const keywords = [...c.keywords.values()]
      .map(k => finish({ ...k, matchTypes: [...k.matchTypes], adGroups: [...k.adGroups], searchTerms: [...k.searchTerms] }))
      .sort((x, y) => y.wc.leads - x.wc.leads || y.ads.cost - x.ads.cost);
    return finish({ ...c, keywords });
  }).sort((x, y) => y.wc.leads - x.wc.leads || y.ads.cost - x.ads.cost);

  const totals = finish({ ads: emptyAds(), wc: emptyWc(), ga: emptyGa() });
  for (const c of out) {
    addAds(totals.ads, c.ads);
    addGa(totals.ga, c.ga);
    for (const l of c.wc.items) addWc(totals.wc, l);
  }
  finish(totals);

  return { campaigns: out, totals, unattributed };
}

/** Filter a report by campaign / keyword search text. */
export function filterReport(report, { campaign = '', keyword = '' } = {}) {
  const cq = campaign.trim().toLowerCase();
  const kq = keyword.trim().toLowerCase();
  const campaigns = [];
  for (const c of report.campaigns) {
    if (cq && !c.name.toLowerCase().includes(cq)) continue;
    if (!kq) { campaigns.push(c); continue; }
    const kws = c.keywords.filter(k => k.keyword.includes(kq) || k.searchTerms.some(t => t.includes(kq)));
    if (!kws.length) continue;
    // When searching by keyword, the campaign row shows only the matching keywords' totals.
    // GA4 has no keyword split, so its campaign figures drop out here.
    const sum = { ads: emptyAds(), wc: emptyWc(), ga: null };
    for (const k of kws) {
      addAds(sum.ads, k.ads);
      for (const l of k.wc.items) addWc(sum.wc, l);
    }
    campaigns.push(finish({ ...c, ads: sum.ads, wc: sum.wc, ga: sum.ga, keywords: kws, keywordFiltered: true }));
  }
  return campaigns;
}

/** Totals across a list of campaign rows. */
export function sumRows(rows) {
  const t = { ads: emptyAds(), wc: emptyWc(), ga: emptyGa() };
  for (const r of rows) {
    addAds(t.ads, r.ads);
    if (r.ga) addGa(t.ga, r.ga);
    for (const l of r.wc.items) addWc(t.wc, l);
  }
  return finish(t);
}

/** Site-wide GA4 totals for the date range, across all channels. */
export function gaSiteTotals(ga, { from = '', to = '' } = {}) {
  const t = emptyGa();
  for (const r of ga) if (inRange(r.date, from, to)) addGa(t, r);
  return t;
}

/**
 * Search Console queries for the date range, each flagged with the Google Ads
 * keyword it overlaps (same normalized text), so paid and organic sit side by side.
 */
export function organicQueries({ gsc = [], adsKeywords = [], leads = [], options = {}, keyword = '' }) {
  const { from = '', to = '', excludeSpam = true } = options;
  const kq = keyword.trim().toLowerCase();
  const paid = new Map();
  for (const r of adsKeywords) {
    if (!inRange(r.date, from, to)) continue;
    const key = normKeyword(r.keyword);
    if (!paid.has(key)) paid.set(key, emptyAds());
    addAds(paid.get(key), r);
  }
  const queries = new Map();
  const totals = { clicks: 0, impressions: 0, posWeighted: 0 };
  for (const r of gsc) {
    if (!inRange(r.date, from, to)) continue;
    totals.clicks += r.clicks; totals.impressions += r.impressions; totals.posWeighted += r.position * r.impressions;
    const key = normKeyword(r.query);
    if (kq && !key.includes(kq)) continue;
    if (!queries.has(key)) queries.set(key, { query: key, clicks: 0, impressions: 0, posWeighted: 0 });
    const q = queries.get(key);
    q.clicks += r.clicks; q.impressions += r.impressions; q.posWeighted += r.position * r.impressions;
  }
  const withRates = q => ({
    ...q,
    ctr: q.impressions ? q.clicks / q.impressions : null,
    position: q.impressions ? q.posWeighted / q.impressions : null,
  });
  const rows = [...queries.values()].map(q => ({ ...withRates(q), paid: paid.get(q.query) || null }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  const organicLeads = leads.filter(l =>
    isGoogleOrganicLead(l) && inRange(l.date, from, to) && !(excludeSpam && (l.spam || l.duplicate))).length;
  return { rows, totals: { ...withRates(totals), organicLeads } };
}

/** Business Profile activity per location for the date range, plus WhatConverts leads it produced. */
export function businessProfileSummary({ gbp = [], leads = [], options = {} }) {
  const { from = '', to = '', excludeSpam = true } = options;
  const empty = () => ({ impressions: 0, calls: 0, websiteClicks: 0, directions: 0 });
  const add = (t, r) => { for (const k of ['impressions', 'calls', 'websiteClicks', 'directions']) t[k] += r[k]; };
  const locations = new Map();
  const totals = empty();
  for (const r of gbp) {
    if (!inRange(r.date, from, to)) continue;
    if (!locations.has(r.locationId)) locations.set(r.locationId, { id: r.locationId, name: r.location, ...empty() });
    add(locations.get(r.locationId), r);
    add(totals, r);
  }
  const wcLeads = leads.filter(l =>
    isBusinessProfileLead(l) && inRange(l.date, from, to) && !(excludeSpam && (l.spam || l.duplicate)));
  return {
    locations: [...locations.values()].sort((a, b) => b.calls - a.calls || b.impressions - a.impressions),
    totals,
    wcLeads,
  };
}
