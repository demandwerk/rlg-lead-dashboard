import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseCSV, parseAdsCSV, parseWhatConvertsCSV, wcRecord, adsRecord,
  normCampaign, normKeyword, isGoogleAdsLead, buildReport, filterReport, decodeBytes,
  gaRecord, gscRecord, gaSiteTotals, organicQueries, sumRows,
} from '../public/core.js';

const sample = f => fs.readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');

test('parseCSV handles quotes, embedded commas and newlines', () => {
  const rows = parseCSV('a,b\n"x, y","line1\nline2"\n"he said ""hi""",2\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'line1\nline2'], ['he said "hi"', '2']]);
});

test('decodeBytes reads UTF-16LE Google Ads "Excel CSV" exports', () => {
  const text = 'Campaign\tClicks\r\nBrand\t5\r\n';
  const buf = new Uint8Array(2 + text.length * 2);
  buf[0] = 0xff; buf[1] = 0xfe;
  for (let i = 0; i < text.length; i++) buf[2 + i * 2] = text.charCodeAt(i);
  const { kind, rows } = parseAdsCSV(decodeBytes(buf));
  assert.equal(kind, 'campaign');
  assert.equal(rows[0].campaign, 'Brand');
  assert.equal(rows[0].clicks, 5);
});

test('parseAdsCSV skips title lines and total rows, parses formatted numbers', () => {
  const csv = 'Campaign report\n"Oct 1, 2026 - Oct 15, 2026"\nCampaign,Impr.,Clicks,Cost,Conversions\n'
    + 'Brand,"1,200",80,"$1,234.50",4.00\nTotal: Account,--,--,--,--\n';
  const { kind, rows } = parseAdsCSV(csv);
  assert.equal(kind, 'campaign');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].impressions, rows[0].cost, rows[0].conversions], [1200, 1234.5, 4]);
});

test('normalizers make UTM values match Google Ads names', () => {
  assert.equal(normCampaign('Search+-+Personal+Injury'), normCampaign('Search - Personal Injury'));
  assert.equal(normCampaign('search_personal%20injury'), 'search personal injury');
  assert.equal(normKeyword('[Car Accident Lawyer]'), 'car accident lawyer');
  assert.equal(normKeyword('"car accident lawyer"'), 'car accident lawyer');
  assert.equal(normKeyword('+car +accident'), 'car accident');
});

test('wcRecord reads both API JSON and CSV header styles', () => {
  const api = wcRecord({ lead_id: 1, lead_type: 'Phone Call', lead_source: 'google', lead_medium: 'cpc',
    lead_campaign: 'Brand', lead_keyword: 'rlg', quotable: 'Yes', sales_value: '500', date_created: '2026-10-01T10:00:00Z', spam: false });
  const csv = wcRecord({ 'Lead ID': '1', 'Lead Type': 'Phone Call', 'Lead Source': 'google', 'Lead Medium': 'cpc',
    'Lead Campaign': 'Brand', 'Lead Keyword': 'rlg', Quotable: 'Yes', 'Sales Value': '$500', 'Date Created': '10/01/2026' });
  for (const r of [api, csv]) {
    assert.equal(r.campaign, 'Brand');
    assert.equal(r.keyword, 'rlg');
    assert.equal(r.quotable, true);
    assert.equal(r.salesValue, 500);
    assert.equal(r.date, '2026-10-01');
    assert.equal(isGoogleAdsLead(r), true);
  }
  assert.equal(isGoogleAdsLead(wcRecord({ lead_source: 'google', lead_medium: 'organic' })), false);
  assert.equal(isGoogleAdsLead(wcRecord({ lead_source: 'bing', lead_medium: 'cpc', gclid: 'abc' })), true);
});

test('buildReport joins leads to campaigns and keywords, incl. campaign-ID UTMs', () => {
  const adsCampaigns = [adsRecord({ campaign: 'Search - PI', campaignId: '111', cost: 1000, clicks: 50, conversions: 3 })];
  const adsKeywords = [
    adsRecord({ campaign: 'Search - PI', campaignId: '111', keyword: 'car accident lawyer', matchType: 'Exact', cost: 600, clicks: 30, conversions: 2 }),
    adsRecord({ campaign: 'Search - PI', campaignId: '111', keyword: 'injury lawyer', cost: 300, clicks: 15, conversions: 1 }),
  ];
  const lead = o => wcRecord({ lead_source: 'google', lead_medium: 'cpc', lead_type: 'Phone Call', date_created: '2026-10-02', ...o });
  const leads = [
    lead({ lead_campaign: 'Search+-+PI', lead_keyword: '[car accident lawyer]', quotable: 'Yes', sales_value: 5000 }),
    lead({ lead_campaign: '111', lead_keyword: 'car accident lawyer', lead_type: 'Web Form' }),
    lead({ lead_campaign: 'Search - PI', lead_keyword: 'injury lawyer', spam: 'true' }),
    lead({ lead_campaign: 'Old Campaign', lead_keyword: 'x' }),
    lead({ lead_campaign: 'Search - PI', lead_medium: 'organic' }),
  ];
  const report = buildReport({ adsCampaigns, adsKeywords, leads });
  const pi = report.campaigns.find(c => c.name === 'Search - PI');
  assert.equal(pi.ads.cost, 1000, 'campaign spend comes from campaign report, not keyword sum');
  assert.equal(pi.wc.leads, 2);
  assert.equal(pi.wc.phone, 1);
  assert.equal(pi.wc.form, 1);
  assert.equal(pi.wc.quotable, 1);
  assert.equal(pi.metrics.costPerLead, 500);
  assert.equal(pi.metrics.convGap, -1);
  const kw = pi.keywords.find(k => k.keyword === 'car accident lawyer');
  assert.equal(kw.wc.leads, 2);
  assert.equal(kw.ads.cost, 600);
  assert.deepEqual(kw.matchTypes, ['Exact']);
  const old = report.campaigns.find(c => c.name === 'Old Campaign');
  assert.equal(old.inAds, false);
  assert.equal(report.totals.wc.leads, 3);
  assert.equal(report.totals.wc.salesValue, 5000);

  const all = buildReport({ adsCampaigns, adsKeywords, leads, options: { googleOnly: false, excludeSpam: false } });
  assert.equal(all.totals.wc.leads, 5);
});

test('date range filters leads and dated ads rows', () => {
  const adsCampaigns = [
    adsRecord({ campaign: 'A', date: '2026-09-01', cost: 100 }),
    adsRecord({ campaign: 'A', date: '2026-10-01', cost: 50 }),
  ];
  const leads = [
    wcRecord({ lead_campaign: 'A', gclid: 'g', date_created: '2026-09-01' }),
    wcRecord({ lead_campaign: 'A', gclid: 'g', date_created: '2026-10-01' }),
  ];
  const r = buildReport({ adsCampaigns, leads, options: { from: '2026-09-15', to: '2026-10-31' } });
  assert.equal(r.campaigns[0].ads.cost, 50);
  assert.equal(r.campaigns[0].wc.leads, 1);
});

test('filterReport searches campaigns and keywords', () => {
  const report = buildReport({
    adsCampaigns: [], adsKeywords: [
      adsRecord({ campaign: 'Search - PI', keyword: 'car accident lawyer', cost: 10 }),
      adsRecord({ campaign: 'Search - PI', keyword: 'injury lawyer', cost: 20 }),
      adsRecord({ campaign: 'Brand', keyword: 'rlg law', cost: 5 }),
    ], leads: [],
  });
  assert.deepEqual(filterReport(report, { campaign: 'brand' }).map(c => c.name), ['Brand']);
  const byKw = filterReport(report, { keyword: 'accident' });
  assert.equal(byKw.length, 1);
  assert.equal(byKw[0].keywords.length, 1);
  assert.equal(byKw[0].ads.cost, 10, 'campaign row shows only matching keyword totals');
});

test('sample files parse and cross-reference end to end', () => {
  const leads = parseWhatConvertsCSV(sample('whatconverts-leads.csv'));
  const c = parseAdsCSV(sample('google-ads-campaigns.csv'));
  const k = parseAdsCSV(sample('google-ads-keywords.csv'));
  assert.equal(c.kind, 'campaign');
  assert.equal(k.kind, 'keyword');
  const report = buildReport({ adsCampaigns: c.rows, adsKeywords: k.rows, leads });
  const wc = report.campaigns.find(x => x.name === 'Search - Workers Comp');
  assert.ok(wc.inAds && wc.wc.leads > 0, 'campaign-ID UTMs resolve to the campaign name');
  assert.ok(report.campaigns.some(x => x.name === 'Search - Legacy Campaign' && !x.inAds));
  assert.ok(report.campaigns.every(x => x.name !== '(no campaign)'), 'organic leads excluded by default');
});

test('search terms roll up to the longest matching bidded keyword', () => {
  const adsKeywords = [
    adsRecord({ campaign: 'PI', keyword: 'accident lawyer', cost: 100 }),
    adsRecord({ campaign: 'PI', keyword: 'car accident lawyer', cost: 200 }),
  ];
  const lead = kw => wcRecord({ lead_campaign: 'PI', lead_keyword: kw, gclid: 'g' });
  const report = buildReport({ adsKeywords, leads: [lead('car accident lawyer free consultation'), lead('dog bite')] });
  const pi = report.campaigns[0];
  const car = pi.keywords.find(k => k.keyword === 'car accident lawyer');
  assert.equal(car.wc.leads, 1);
  assert.deepEqual(car.searchTerms, ['car accident lawyer free consultation']);
  const dog = pi.keywords.find(k => k.keyword === 'dog bite');
  assert.equal(dog.inAds, false);
  assert.equal(dog.metrics.costPerLead, null);
  assert.equal(dog.metrics.convGap, null);
  assert.equal(filterReport(report, { keyword: 'consultation' })[0].keywords[0].keyword, 'car accident lawyer');
});

test('GA4 sessions join to known campaigns by name or ID, respecting filters', () => {
  const adsCampaigns = [adsRecord({ campaign: 'Search - PI', campaignId: '111', cost: 100 })];
  const leads = [wcRecord({ lead_campaign: 'Legacy', gclid: 'g' })];
  const ga = [
    gaRecord({ date: '2026-10-01', source: 'google', medium: 'cpc', campaign: 'search_-_pi', sessions: 40, engagedSessions: 20, keyEvents: 3 }),
    gaRecord({ date: '2026-10-02', source: 'google', medium: 'cpc', campaign: '111', sessions: 10, keyEvents: 1 }),
    gaRecord({ date: '2026-10-02', source: 'google', medium: 'cpc', campaign: 'Legacy', sessions: 5 }),
    gaRecord({ date: '2026-10-02', source: 'newsletter', medium: 'email', campaign: 'Search - PI', sessions: 7 }),
    gaRecord({ date: '2026-10-02', source: 'google', medium: 'cpc', campaign: 'Unknown', sessions: 99 }),
    gaRecord({ date: '2026-09-01', source: 'google', medium: 'cpc', campaign: 'Search - PI', sessions: 1000 }),
  ];
  const r = buildReport({ adsCampaigns, leads, ga, options: { from: '2026-09-15' } });
  const pi = r.campaigns.find(c => c.name === 'Search - PI');
  assert.deepEqual(pi.ga, { sessions: 50, engagedSessions: 20, keyEvents: 4 });
  assert.equal(r.campaigns.find(c => c.name === 'Legacy').ga.sessions, 5);
  assert.ok(!r.campaigns.some(c => c.name === 'Unknown'), 'GA-only campaigns are not added');
  assert.equal(r.totals.ga.sessions, 55);
  assert.equal(sumRows(r.campaigns).ga.sessions, 55);
  const all = buildReport({ adsCampaigns, leads, ga, options: { from: '2026-09-15', googleOnly: false } });
  assert.equal(all.campaigns.find(c => c.name === 'Search - PI').ga.sessions, 57, 'non-paid sessions count when Google-only is off');
  assert.equal(gaSiteTotals(ga, { from: '2026-09-15' }).sessions, 161);
});

test('organicQueries aggregates Search Console rows and flags paid overlap', () => {
  const gsc = [
    gscRecord({ date: '2026-10-01', query: 'Car Accident Lawyer', clicks: 10, impressions: 100, position: 2 }),
    gscRecord({ date: '2026-10-02', query: 'car accident lawyer', clicks: 5, impressions: 300, position: 6 }),
    gscRecord({ date: '2026-10-02', query: 'dog bite lawyer', clicks: 20, impressions: 50, position: 1 }),
    gscRecord({ date: '2026-08-01', query: 'old', clicks: 999, impressions: 999, position: 1 }),
  ];
  const adsKeywords = [adsRecord({ campaign: 'PI', keyword: '[car accident lawyer]', cost: 80, clicks: 4, date: '2026-10-01' })];
  const leads = [
    wcRecord({ lead_source: 'google', lead_medium: 'organic', date_created: '2026-10-01' }),
    wcRecord({ lead_source: 'google', lead_medium: 'organic', date_created: '2026-10-01', spam: 'yes' }),
    wcRecord({ lead_source: 'google', lead_medium: 'cpc', date_created: '2026-10-01' }),
  ];
  const { rows, totals } = organicQueries({ gsc, adsKeywords, leads, options: { from: '2026-09-15' } });
  assert.deepEqual(rows.map(q => q.query), ['dog bite lawyer', 'car accident lawyer']);
  const car = rows[1];
  assert.equal(car.clicks, 15);
  assert.equal(car.position, 5, 'position is impression-weighted');
  assert.equal(car.paid.cost, 80);
  assert.equal(rows[0].paid, null);
  assert.equal(totals.clicks, 35);
  assert.equal(totals.organicLeads, 1);
  assert.equal(organicQueries({ gsc, options: { from: '2026-09-15' }, keyword: 'dog' }).rows.length, 1);
});
