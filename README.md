# RLG Lead Dashboard

Search Google Ads campaigns and keywords, and see the **WhatConverts** leads (calls, forms, chats) each one produced, side by side with Google Ads spend, clicks and conversions, **Google Analytics 4** sessions and key events, **Search Console** organic queries, and **Google Business Profile** calls, website clicks and direction requests.

- **Search** by campaign and/or keyword (keyword search also matches the search terms WhatConverts captured).
- **Per campaign → per keyword**: spend, clicks, Google Ads conversions, WhatConverts leads (split into calls, forms and chat), quotable leads, cost per lead, sales value.
- **Gap column**: WhatConverts leads minus Google Ads conversions, so you can see where Ads under- or over-reports.
- Click any lead count to see the individual leads behind it.
- Flags campaigns and keywords that have WhatConverts leads but **no match in Google Ads** (renamed or paused campaigns, broken UTMs).
- **GA sessions / GA key events** columns per campaign, so Ads conversions, GA4 key events and WhatConverts leads sit next to each other.
- **Organic search** table from Search Console: clicks, impressions, CTR and average position per query, with the Ads spend on the same keyword when you also bid on it.
- **Google Business Profile** table per location (impressions, calls, website clicks, direction requests), with the WhatConverts leads tagged as coming from the profile.
- Date range filter, a "Google Ads leads only" toggle, spam and duplicate exclusion, and CSV export.

## Run it

Requires Node 18 or newer. There are no dependencies to install.

```bash
npm start            # http://localhost:3000
npm test
```

Click **Load sample data** to try it with fictional data.

## Getting data in

### Option A: Live connections (recommended)

Once connected, the dashboard pulls fresh data every time it is opened (last 30 days by default), and again whenever you widen the date range. **Refresh data** forces a new pull; otherwise results are cached on the server for 10 minutes.

Copy `.env.example` to `.env`, fill in the steps below, then `npm start` and open **Connections**.

#### WhatConverts

1. WhatConverts → **Integrations → API Keys** → create a key (a profile key, or a master account key).
2. Put the token and secret in `WHATCONVERTS_API_TOKEN` and `WHATCONVERTS_API_SECRET`. With a master key, also set `WHATCONVERTS_PROFILE_ID`.

#### Google Ads, Google Analytics 4, Search Console and Business Profile

One Google sign-in covers all four.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (**Location: No organization** is fine; you don't need a Cloud organization) and enable the **Google Ads API**, **Google Analytics Data API**, **Google Analytics Admin API**, **Google Search Console API**, **My Business Account Management API**, **My Business Business Information API** and **Business Profile Performance API**.
2. **APIs & Services → OAuth consent screen** (shown as **Google Auth Platform**): choose **Internal** if your account is on Google Workspace with an organization, otherwise **External**. For External, open **Audience → Publish app**, because refresh tokens for apps left in "Testing" expire after 7 days. You don't need Google's app verification for your own use: on first sign-in Google shows "Google hasn't verified this app"; click **Advanced → Go to (app name)**.
3. **Credentials → Create credentials → OAuth client ID → Web application**. Add this authorized redirect URI:
   `http://localhost:3000/auth/google/callback` (on a server, use your URL and set `PUBLIC_URL` to match).
4. Put the client ID and secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. For Google Ads, also set `GOOGLE_ADS_DEVELOPER_TOKEN` (Google Ads MCC → Tools → API Center), `GOOGLE_ADS_CUSTOMER_ID` (e.g. `123-456-7890`), and `GOOGLE_ADS_LOGIN_CUSTOMER_ID` if access is through a manager account.
6. For Business Profile, request API access with Google's [access request form](https://developers.google.com/my-business/content/prereqs#request-access), using the same Cloud project number. Until Google approves it (often a few days), the Business Profile APIs have a quota of zero and return errors; everything else works in the meantime.
7. Restart, open **Connections → Connect Google**, and sign in with an account that can see the Ads account, the GA4 property, the Search Console site and the Business Profile.
8. Pick the **GA4 property**, **Search Console site** and **Business Profile locations**, then click **Save & sync**.

The Google sign-in is saved to `data/google-connection.json` (gitignored, owner-readable only). **Disconnect** revokes it. Existing setups that use `GOOGLE_ADS_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` keep working for Ads; click **Connect Google** once to add Analytics, Search Console and Business Profile access. If you connected before Business Profile was added, click **Reconnect** once so the sign-in includes it.

| Variable | Where to get it |
|---|---|
| `WHATCONVERTS_API_TOKEN` / `_SECRET` | WhatConverts → Integrations → API Keys |
| `WHATCONVERTS_PROFILE_ID` | Only needed with a master account key |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Google Cloud console → OAuth client (Web application) |
| `PUBLIC_URL` | Only when hosted behind a proxy or custom domain |
| `GA4_PROPERTY_ID` / `SEARCH_CONSOLE_SITE_URL` / `GBP_LOCATION_IDS` | Optional; normally picked in the Connections panel |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads MCC → Tools → API Center |
| `GOOGLE_ADS_CUSTOMER_ID` | The ad account, e.g. `123-456-7890` |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Your MCC ID, if access is through a manager account |
| `DASHBOARD_PASSWORD` | Puts a login prompt in front of the dashboard. **Set this on any server others can reach**, since the Connections panel can change the Google account. |

Credentials stay on the server. The browser only talks to the dashboard's own `/api/*` routes.

**How GA4 and Search Console are joined**

- GA4 sessions and key events are matched to campaigns by *session campaign name* (or campaign ID), the same way WhatConverts leads are. With **Google Ads leads only** on, only `google / cpc` sessions count. GA4 doesn't split by keyword, so keyword rows show "—".
- Search Console queries are matched to bidded keywords by text, so you can spot terms you pay for while already ranking organically. The KPI tile also counts WhatConverts leads with source `google` / medium `organic`. Search Console data runs 2–3 days behind.
- Business Profile metrics are per location and are not joined to campaigns. Leads count as Business Profile leads when their source, medium or campaign says `gmb`, `gbp`, "Google My Business", "Business Profile" or "Google Maps" (WhatConverts' GBP integration, or `?utm_source=google&utm_medium=organic&utm_campaign=gmb` on the profile's website link). Those leads are left out of the organic search count so they aren't counted twice.

### Option B: CSV exports (no setup)

1. **WhatConverts** → Leads → filter the date range → Export → CSV. Upload with **WhatConverts CSV**.
2. **Google Ads** → Campaigns, or Keywords → Search keywords → Download → CSV. Upload with **Google Ads CSV**. You can select both files at once; the app detects which is which.
   - Add the **Day** segment (Segment → Time → Day) if you want the date filter to apply to Ads spend too.
   - Add the **Campaign ID** column if your UTMs use `{campaignid}` instead of the campaign name.

Uploaded data stays in the browser tab. Nothing is sent to the server.

## How leads are matched to campaigns and keywords

1. **Google Ads leads only** (on by default): a lead counts if it has a GCLID, or if its source is `google` and its medium is `cpc`, `ppc` or `paid`.
2. **Campaign**: WhatConverts' *Lead Campaign* (usually `utm_campaign`) is matched to the Google Ads campaign name. Matching ignores case, `+`/`%20` encoding and `_` versus spaces. If the value is a campaign ID, it is mapped to the name.
3. **Keyword**: *Lead Keyword* is matched to the bidded keyword in that campaign. Match-type punctuation (`[ ]`, `" "`, `+`) is stripped before comparing. If WhatConverts recorded the search term instead (e.g. "car accident lawyer free consultation"), the lead rolls up to the longest bidded keyword whose words all appear in it ("car accident lawyer"). Leads that match nothing are listed under the campaign as "not in Google Ads".

For the best match rates, enable the Google Ads integration in WhatConverts, or make sure your final URL suffix or tracking template sets `utm_campaign={campaignname}` (or `{campaignid}`) and `utm_term={keyword}`.
