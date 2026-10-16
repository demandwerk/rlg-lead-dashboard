// Zero-dependency server: serves the dashboard and proxies WhatConverts +
// Google Ads APIs so credentials never reach the browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wcRecord, adsRecord } from './public/core.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));

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

const wcConfigured = () => !!(env('WHATCONVERTS_API_TOKEN') && env('WHATCONVERTS_API_SECRET'));
const adsConfigured = () => ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID'].every(k => env(k));

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

// ---------- Google Ads ----------

let tokenCache = { token: '', expires: 0 };
async function googleAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires - 60_000) return tokenCache.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env('GOOGLE_ADS_CLIENT_ID'),
      client_secret: env('GOOGLE_ADS_CLIENT_SECRET'),
      refresh_token: env('GOOGLE_ADS_REFRESH_TOKEN'),
    }),
  });
  if (!res.ok) throw new Error(`Google OAuth ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  tokenCache = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return tokenCache.token;
}

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

// ---------- HTTP ----------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv', '.svg': 'image/svg+xml' };

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
    if (url.pathname === '/api/status') {
      return send(res, 200, { whatconverts: wcConfigured(), googleAds: adsConfigured() });
    }
    if (url.pathname === '/api/sync') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!isDate(from) || !isDate(to)) return send(res, 400, { error: 'from and to must be YYYY-MM-DD' });
      const errors = [];
      const [leads, ads] = await Promise.all([
        wcConfigured() ? fetchWhatConvertsLeads(from, to).catch(e => { errors.push(e.message); return null; }) : null,
        adsConfigured() ? fetchGoogleAds(from, to).catch(e => { errors.push(e.message); return null; }) : null,
      ]);
      return send(res, 200, { leads, ...(ads || {}), errors });
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
  console.log(`Lead dashboard on http://localhost:${PORT}`);
  console.log(`  WhatConverts API: ${wcConfigured() ? 'configured' : 'not configured (CSV upload only)'}`);
  console.log(`  Google Ads API:   ${adsConfigured() ? 'configured' : 'not configured (CSV upload only)'}`);
});
