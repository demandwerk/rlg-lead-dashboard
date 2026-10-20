// Zero-dependency server: serves the dashboard and proxies WhatConverts, Google
// Ads, GA4, Search Console and Business Profile APIs so credentials never reach
// the browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { wcRecord, adsRecord, gaRecord, gscRecord, gbpRecord } from './public/core.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));
// Written by the "Connect Google" flow and the settings picker. Holds a refresh
// token, so it is gitignored and created owner-readable only.
const CONNECTION_FILE = path.join(ROOT, 'data', 'google-connection.json');

const PORT = Number(process.env.PORT) || 3000;
const env = k => (process.env[k] || '').trim();

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function readConnection() {
  try { return JSON.parse(fs.readFileSync(CONNECTION_FILE, 'utf8')); } catch { return {}; }
}
function writeConnection(patch) {
  const next = { ...readConnection(), ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  fs.mkdirSync(path.dirname(CONNECTION_FILE), { recursive: true });
  fs.writeFileSync(CONNECTION_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  tokenCache = { token: '', expires: 0 };
  syncCache.clear();
}

// One Google OAuth client and refresh token covers Ads, GA4, Search Console and
// Business Profile.
// GOOGLE_ADS_* names still work for setups made before GA4/GSC were added.
const google = {
  clientId: () => env('GOOGLE_CLIENT_ID') || env('GOOGLE_ADS_CLIENT_ID'),
  clientSecret: () => env('GOOGLE_CLIENT_SECRET') || env('GOOGLE_ADS_CLIENT_SECRET'),
  refreshToken: () => readConnection().refreshToken || env('GOOGLE_REFRESH_TOKEN') || env('GOOGLE_ADS_REFRESH_TOKEN'),
  ga4Property: () => String(readConnection().ga4PropertyId || env('GA4_PROPERTY_ID')).replace(/^properties\//, ''),
  gscSite: () => readConnection().gscSiteUrl || env('SEARCH_CONSOLE_SITE_URL'),
  // [{ id, title }]; GBP_LOCATION_IDS takes a comma-separated list of location IDs.
  gbpLocations: () => readConnection().gbpLocations
    || env('GBP_LOCATION_IDS').split(',').map(id => id.trim().replace(/^locations\//, '')).filter(Boolean).map(id => ({ id, title: id })),
};
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/adwords',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/business.manage',
  'openid', 'email',
];

const wcConfigured = () => !!(env('WHATCONVERTS_API_TOKEN') && env('WHATCONVERTS_API_SECRET'));
const googleClientConfigured = () => !!(google.clientId() && google.clientSecret());
const googleConnected = () => googleClientConfigured() && !!google.refreshToken();
const adsConfigured = () => googleConnected() && !!(env('GOOGLE_ADS_DEVELOPER_TOKEN') && env('GOOGLE_ADS_CUSTOMER_ID'));
const gaConfigured = () => googleConnected() && !!google.ga4Property();
const gscConfigured = () => googleConnected() && !!google.gscSite();
const gbpConfigured = () => googleConnected() && google.gbpLocations().length > 0;

// ---------- WhatConverts ----------

async function fetchWhatConvertsLeads(from, to) {
  const auth = Buffer.from(`${env('WHATCONVERTS_API_TOKEN')}:${env('WHATCONVERTS_API_SECRET')}`).toString('base64');
  const leads = [];
  for (let page = 1, totalPages = 1; page <= totalPages; page++) {
    const qs = new URLSearchParams({ leads_per_page: '250', page_number: String(page) });
    if (from) qs.set('start_date', from);
    if (to) qs.set('end_date', to);
    if (env('WHATCONVERTS_PROFILE_ID')) qs.set('profile_id', env('WHATCONVERTS_PROFILE_ID'));
    const res = await fetch(`https://app.whatconverts.com/api/v1/leads?${qs}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`WhatConverts API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    totalPages = Number(body.total_pages) || 1;
    for (const l of body.leads || []) leads.push(wcRecord(l));
    if (page >= 200) break; // safety valve (50k leads)
  }
  return leads;
}

// ---------- Google auth ----------

let tokenCache = { token: '', expires: 0 };
async function googleAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires - 60_000) return tokenCache.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: google.clientId(),
      client_secret: google.clientSecret(),
      refresh_token: google.refreshToken(),
    }),
  });
  if (!res.ok) throw new Error(`Google sign-in expired or was revoked (${res.status}). Click "Connect Google" again.`);
  const body = await res.json();
  tokenCache = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return tokenCache.token;
}

async function googleApi(label, url, body) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${await googleAccessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.ok) return res.json();
  const text = await res.text();
  const hint = /insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)
    ? ' The saved Google sign-in does not include this access; click "Connect Google" again.' : '';
  throw new Error(`${label} API ${res.status}: ${text.slice(0, 300)}${hint}`);
}

// Where Google sends the browser back to. Must match an "Authorized redirect
// URI" on the OAuth client exactly.
function redirectUri(req) {
  if (env('PUBLIC_URL')) return `${env('PUBLIC_URL').replace(/\/$/, '')}/auth/google/callback`;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}/auth/google/callback`;
}

const oauthStates = new Map(); // state -> expiry, guards the callback against forged requests

function startGoogleAuth(req, res) {
  const state = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  for (const [k, exp] of oauthStates) if (exp < now) oauthStates.delete(k);
  oauthStates.set(state, now + 10 * 60_000);
  const qs = new URLSearchParams({
    client_id: google.clientId(), redirect_uri: redirectUri(req), response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${qs}` });
  res.end();
}

async function finishGoogleAuth(req, res, url) {
  const state = url.searchParams.get('state');
  const valid = state && (oauthStates.get(state) || 0) > Date.now();
  oauthStates.delete(state);
  const back = msg => { res.writeHead(302, { Location: `/?google=${encodeURIComponent(msg)}` }); res.end(); };
  if (!valid) return back('Sign-in link expired, please try again');
  if (url.searchParams.get('error')) return back(`Google sign-in cancelled (${url.searchParams.get('error')})`);
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: url.searchParams.get('code') || '',
      client_id: google.clientId(), client_secret: google.clientSecret(), redirect_uri: redirectUri(req),
    }),
  });
  const body = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !body.refresh_token) {
    return back(`Google sign-in failed: ${body.error_description || body.error || 'no refresh token returned'}`);
  }
  let email = '';
  try { email = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64url')).email || ''; } catch { /* optional */ }
  writeConnection({ refreshToken: body.refresh_token, email, scopes: body.scope });
  return back('connected');
}

async function disconnectGoogle() {
  const token = readConnection().refreshToken;
  if (token) {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    }).catch(() => {});
  }
  writeConnection({ refreshToken: undefined, email: undefined, scopes: undefined });
}

// Business Profile locations across every account the signed-in user manages.
async function listBusinessProfileLocations() {
  const accounts = [];
  let pageToken = '';
  do {
    const body = await googleApi('Business Profile',
      `https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20${pageToken ? `&pageToken=${pageToken}` : ''}`);
    accounts.push(...(body.accounts || []));
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  const out = [];
  for (const a of accounts) {
    pageToken = '';
    do {
      const body = await googleApi('Business Profile',
        `https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title,storefrontAddress&pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`);
      for (const l of body.locations || []) {
        const city = l.storefrontAddress?.locality;
        out.push({ id: l.name.replace('locations/', ''), title: city ? `${l.title} (${city})` : l.title });
      }
      pageToken = body.nextPageToken || '';
    } while (pageToken);
  }
  return out;
}

// GA4 properties, Search Console sites and Business Profile locations the
// signed-in Google user can see, for the settings picker.
async function listGoogleAccounts() {
  const [ga, gsc, gbp] = await Promise.allSettled([
    (async () => {
      const out = [];
      let pageToken = '';
      do {
        const body = await googleApi('Google Analytics Admin',
          `https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`);
        for (const a of body.accountSummaries || []) {
          for (const p of a.propertySummaries || []) {
            out.push({ id: p.property.replace('properties/', ''), name: `${p.displayName} (${a.displayName})` });
          }
        }
        pageToken = body.nextPageToken || '';
      } while (pageToken);
      return out;
    })(),
    googleApi('Search Console', 'https://www.googleapis.com/webmasters/v3/sites')
      .then(b => (b.siteEntry || []).filter(s => s.permissionLevel !== 'siteUnverifiedUser').map(s => s.siteUrl).sort()),
    listBusinessProfileLocations(),
  ]);
  return {
    ga4Properties: ga.status === 'fulfilled' ? ga.value : [],
    gscSites: gsc.status === 'fulfilled' ? gsc.value : [],
    gbpLocations: gbp.status === 'fulfilled' ? gbp.value : [],
    errors: [ga, gsc, gbp].filter(r => r.status === 'rejected').map(r => r.reason.message),
  };
}

// ---------- Google Analytics 4 ----------

async function fetchGa4(from, to) {
  const rows = [];
  const limit = 100_000;
  for (let offset = 0; ; offset += limit) {
    const body = await googleApi('Google Analytics',
      `https://analyticsdata.googleapis.com/v1beta/properties/${google.ga4Property()}:runReport`, {
        dateRanges: [{ startDate: from, endDate: to }],
        dimensions: ['date', 'sessionSource', 'sessionMedium', 'sessionCampaignName'].map(name => ({ name })),
        metrics: ['sessions', 'engagedSessions', 'keyEvents'].map(name => ({ name })),
        limit, offset,
      });
    for (const r of body.rows || []) {
      const [d, source, medium, campaign] = r.dimensionValues.map(v => v.value);
      const [sessions, engagedSessions, keyEvents] = r.metricValues.map(v => v.value);
      rows.push(gaRecord({
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, source, medium, campaign, sessions, engagedSessions, keyEvents,
      }));
    }
    if (offset + limit >= (body.rowCount || 0) || offset >= 900_000) break;
  }
  return rows;
}

// ---------- Search Console ----------

async function fetchSearchConsole(from, to) {
  const rows = [];
  const rowLimit = 25_000;
  const site = encodeURIComponent(google.gscSite());
  for (let startRow = 0; startRow < 250_000; startRow += rowLimit) {
    const body = await googleApi('Search Console',
      `https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, {
        startDate: from, endDate: to, dimensions: ['date', 'query'], type: 'web', rowLimit, startRow,
      });
    for (const r of body.rows || []) {
      rows.push(gscRecord({ date: r.keys[0], query: r.keys[1], clicks: r.clicks, impressions: r.impressions, position: r.position }));
    }
    if ((body.rows || []).length < rowLimit) break;
  }
  return rows;
}

// ---------- Business Profile ----------

const GBP_METRICS = {
  CALL_CLICKS: 'calls',
  WEBSITE_CLICKS: 'websiteClicks',
  BUSINESS_DIRECTION_REQUESTS: 'directions',
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 'impressions',
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'impressions',
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: 'impressions',
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 'impressions',
};

async function fetchBusinessProfile(from, to) {
  const range = (prefix, d) => {
    const [year, month, day] = d.split('-').map(Number);
    return [[`${prefix}.year`, year], [`${prefix}.month`, month], [`${prefix}.day`, day]];
  };
  const perLocation = await Promise.all(google.gbpLocations().map(async loc => {
    const qs = new URLSearchParams([
      ...Object.keys(GBP_METRICS).map(m => ['dailyMetrics', m]),
      ...range('dailyRange.start_date', from), ...range('dailyRange.end_date', to),
    ]);
    const body = await googleApi('Business Profile',
      `https://businessprofileperformance.googleapis.com/v1/locations/${loc.id}:fetchMultiDailyMetricsTimeSeries?${qs}`);
    const byDate = new Map();
    for (const multi of body.multiDailyMetricTimeSeries || []) {
      for (const series of multi.dailyMetricTimeSeries || []) {
        const field = GBP_METRICS[series.dailyMetric];
        for (const v of series.timeSeries?.datedValues || []) {
          const date = `${v.date.year}-${String(v.date.month).padStart(2, '0')}-${String(v.date.day).padStart(2, '0')}`;
          if (!byDate.has(date)) byDate.set(date, { date, locationId: loc.id, location: loc.title });
          const row = byDate.get(date);
          row[field] = (row[field] || 0) + Number(v.value || 0); // days with zero omit "value"
        }
      }
    }
    return [...byDate.values()].map(gbpRecord);
  }));
  return perLocation.flat();
}

// ---------- Google Ads ----------

async function gaql(query) {
  const version = env('GOOGLE_ADS_API_VERSION') || 'v25';
  const customer = env('GOOGLE_ADS_CUSTOMER_ID').replace(/-/g, '');
  const headers = {
    Authorization: `Bearer ${await googleAccessToken()}`,
    'developer-token': env('GOOGLE_ADS_DEVELOPER_TOKEN'),
    'Content-Type': 'application/json',
  };
  if (env('GOOGLE_ADS_LOGIN_CUSTOMER_ID')) headers['login-customer-id'] = env('GOOGLE_ADS_LOGIN_CUSTOMER_ID').replace(/-/g, '');
  const res = await fetch(`https://googleads.googleapis.com/${version}/customers/${customer}/googleAds:searchStream`, {
    method: 'POST', headers, body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Google Ads API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const batches = await res.json();
  return batches.flatMap(b => b.results || []);
}

const metricsOf = m => ({
  impressions: m?.impressions, clicks: m?.clicks,
  cost: Number(m?.costMicros || 0) / 1e6,
  conversions: m?.conversions, convValue: m?.conversionsValue,
});

async function fetchGoogleAds(from, to) {
  const where = `segments.date BETWEEN '${from}' AND '${to}'`;
  const metrics = 'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value';
  const [campRows, kwRows] = await Promise.all([
    gaql(`SELECT campaign.id, campaign.name, segments.date, ${metrics} FROM campaign WHERE ${where}`),
    gaql(`SELECT campaign.id, campaign.name, ad_group.name, ad_group_criterion.keyword.text,
          ad_group_criterion.keyword.match_type, segments.date, ${metrics}
          FROM keyword_view WHERE ${where}`),
  ]);
  return {
    adsCampaigns: campRows.map(r => adsRecord({
      campaign: r.campaign?.name, campaignId: r.campaign?.id, date: r.segments?.date, ...metricsOf(r.metrics),
    })),
    adsKeywords: kwRows.map(r => adsRecord({
      campaign: r.campaign?.name, campaignId: r.campaign?.id, adGroup: r.adGroup?.name,
      keyword: r.adGroupCriterion?.keyword?.text, matchType: r.adGroupCriterion?.keyword?.matchType,
      date: r.segments?.date, ...metricsOf(r.metrics),
    })),
  };
}

// ---------- Sync ----------

// Reloading the page or nudging the date range shouldn't re-pull every API.
const SYNC_TTL = 10 * 60_000;
const syncCache = new Map();

async function syncAll(from, to, fresh) {
  const key = `${from}|${to}`;
  const hit = syncCache.get(key);
  if (!fresh && hit && hit.expires > Date.now()) return hit.body;
  const errors = [];
  const run = (on, fn) => on ? fn(from, to).catch(e => { errors.push(e.message); return null; }) : null;
  const [leads, ads, ga, gsc, gbp] = await Promise.all([
    run(wcConfigured(), fetchWhatConvertsLeads),
    run(adsConfigured(), fetchGoogleAds),
    run(gaConfigured(), fetchGa4),
    run(gscConfigured(), fetchSearchConsole),
    run(gbpConfigured(), fetchBusinessProfile),
  ]);
  const body = { leads, ...(ads || {}), ga, gsc, gbp, errors, syncedAt: new Date().toISOString() };
  if (!errors.length) {
    if (syncCache.size > 20) syncCache.clear();
    syncCache.set(key, { body, expires: Date.now() + SYNC_TTL });
  }
  return body;
}

function status() {
  const c = readConnection();
  return {
    whatconverts: wcConfigured(),
    googleAds: adsConfigured(),
    ga4: gaConfigured(),
    searchConsole: gscConfigured(),
    businessProfile: gbpConfigured(),
    google: {
      clientConfigured: googleClientConfigured(),
      connected: googleConnected(),
      // Connected through .env rather than the button: can't be disconnected from the UI.
      viaEnv: googleConnected() && !c.refreshToken,
      email: c.email || '',
      adsMissing: ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID'].filter(k => !env(k)),
      ga4PropertyId: google.ga4Property(),
      gscSiteUrl: google.gscSite(),
      gbpLocations: google.gbpLocations(),
    },
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

// ---------- HTTP ----------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv', '.json': 'application/json', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function authorized(req) {
  const pw = env('DASHBOARD_PASSWORD');
  if (!pw) return true;
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
  if (!m) return false;
  const [, pass] = Buffer.from(m[1], 'base64').toString().split(/:(.*)/s);
  return pass === pw;
}

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Lead Dashboard"' });
    return res.end('Authentication required');
  }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/status') return send(res, 200, status());
    if (url.pathname === '/api/sync') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!isDate(from) || !isDate(to)) return send(res, 400, { error: 'from and to must be YYYY-MM-DD' });
      return send(res, 200, await syncAll(from, to, url.searchParams.has('fresh')));
    }
    if (url.pathname === '/auth/google') {
      if (!googleClientConfigured()) return send(res, 400, 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.', 'text/plain');
      return startGoogleAuth(req, res);
    }
    if (url.pathname === '/auth/google/callback') return finishGoogleAuth(req, res, url);
    if (url.pathname === '/api/google/accounts') {
      if (!googleConnected()) return send(res, 400, { error: 'Connect Google first' });
      return send(res, 200, await listGoogleAccounts());
    }
    // State-changing calls must be JSON POSTs, which a cross-site form can't forge.
    const jsonPost = req.method === 'POST' && /^application\/json/.test(req.headers['content-type'] || '');
    if (url.pathname === '/api/google/disconnect' && jsonPost) {
      await disconnectGoogle();
      return send(res, 200, status());
    }
    if (url.pathname === '/api/settings' && jsonPost) {
      const body = await readJson(req);
      const patch = {};
      if (typeof body.ga4PropertyId === 'string') patch.ga4PropertyId = body.ga4PropertyId.replace(/[^0-9]/g, '') || undefined;
      if (typeof body.gscSiteUrl === 'string') patch.gscSiteUrl = body.gscSiteUrl.trim() || undefined;
      if (Array.isArray(body.gbpLocations)) {
        const locs = body.gbpLocations
          .map(l => ({ id: String(l?.id || '').replace(/[^0-9]/g, ''), title: String(l?.title || '').slice(0, 200) }))
          .filter(l => l.id);
        patch.gbpLocations = locs.length ? locs : undefined;
      }
      writeConnection(patch);
      return send(res, 200, status());
    }
    // static files
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.normalize(path.join(ROOT, 'public', rel));
    const sampleFile = path.normalize(path.join(ROOT, rel));
    const target = file.startsWith(path.join(ROOT, 'public')) && fs.existsSync(file) ? file
      : rel.startsWith('samples/') && sampleFile.startsWith(path.join(ROOT, 'samples')) && fs.existsSync(sampleFile) ? sampleFile
      : null;
    if (!target || fs.statSync(target).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(target, 'utf8'), MIME[path.extname(target)] || 'text/plain');
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  const on = v => v ? 'connected' : 'not connected';
  console.log(`Lead dashboard on http://localhost:${PORT}`);
  console.log(`  WhatConverts:     ${on(wcConfigured())}`);
  console.log(`  Google Ads:       ${on(adsConfigured())}`);
  console.log(`  GA4:              ${on(gaConfigured())}`);
  console.log(`  Search Console:   ${on(gscConfigured())}`);
  console.log(`  Business Profile: ${on(gbpConfigured())}`);
  if (googleClientConfigured() && !googleConnected()) console.log(`  Open the dashboard and click "Connect Google" to finish Google setup.`);
});
