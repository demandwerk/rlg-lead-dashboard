# RLG Lead Dashboard

Search Google Ads campaigns and keywords, and see the **WhatConverts** leads (calls, forms, chats) each one produced, side by side with Google Ads spend, clicks and conversions.

- **Search** by campaign and/or keyword (keyword search also matches the search terms WhatConverts captured).
- **Per campaign → per keyword**: spend, clicks, Google Ads conversions, WhatConverts leads (split into calls, forms and chat), quotable leads, cost per lead, sales value.
- **Gap column**: WhatConverts leads minus Google Ads conversions, so you can see where Ads under- or over-reports.
- Click any lead count to see the individual leads behind it.
- Flags campaigns and keywords that have WhatConverts leads but **no match in Google Ads** (renamed or paused campaigns, broken UTMs).
- Date range filter, a "Google Ads leads only" toggle, spam and duplicate exclusion, and CSV export.

## Run it

Requires Node 18 or newer. There are no dependencies to install.

```bash
npm start            # http://localhost:3000
npm test
```

Click **Load sample data** to try it with fictional data.

## Getting data in

### Option A: CSV exports (no setup)

1. **WhatConverts** → Leads → filter the date range → Export → CSV. Upload with **WhatConverts CSV**.
2. **Google Ads** → Campaigns, or Keywords → Search keywords → Download → CSV. Upload with **Google Ads CSV**. You can select both files at once; the app detects which is which.
   - Add the **Day** segment (Segment → Time → Day) if you want the date filter to apply to Ads spend too.
   - Add the **Campaign ID** column if your UTMs use `{campaignid}` instead of the campaign name.

Uploaded data stays in the browser tab. Nothing is sent to the server.

### Option B: Live API sync

Copy `.env.example` to `.env` and fill in the credentials. A **Sync from APIs** button then appears, which pulls both sources for the chosen date range.

| Variable | Where to get it |
|---|---|
| `WHATCONVERTS_API_TOKEN` / `_SECRET` | WhatConverts → Integrations → API Keys |
| `WHATCONVERTS_PROFILE_ID` | Only needed with a master account key |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads MCC → Tools → API Center |
| `GOOGLE_ADS_CLIENT_ID` / `_SECRET` | Google Cloud console → OAuth client (Desktop app) |
| `GOOGLE_ADS_REFRESH_TOKEN` | Generate it with the OAuth client above (for example, Google's `generate_user_credentials` example) |
| `GOOGLE_ADS_CUSTOMER_ID` | The ad account, e.g. `123-456-7890` |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Your MCC ID, if access is through a manager account |
| `DASHBOARD_PASSWORD` | Optional. Puts a login prompt in front of the dashboard. |

Credentials stay on the server. The browser only calls `/api/sync`.

## How leads are matched to campaigns and keywords

1. **Google Ads leads only** (on by default): a lead counts if it has a GCLID, or if its source is `google` and its medium is `cpc`, `ppc` or `paid`.
2. **Campaign**: WhatConverts' *Lead Campaign* (usually `utm_campaign`) is matched to the Google Ads campaign name. Matching ignores case, `+`/`%20` encoding and `_` versus spaces. If the value is a campaign ID, it is mapped to the name.
3. **Keyword**: *Lead Keyword* is matched to the bidded keyword in that campaign. Match-type punctuation (`[ ]`, `" "`, `+`) is stripped before comparing. If WhatConverts recorded the search term instead (e.g. "car accident lawyer free consultation"), the lead rolls up to the longest bidded keyword whose words all appear in it ("car accident lawyer"). Leads that match nothing are listed under the campaign as "not in Google Ads".

For the best match rates, enable the Google Ads integration in WhatConverts, or make sure your final URL suffix or tracking template sets `utm_campaign={campaignname}` (or `{campaignid}`) and `utm_term={keyword}`.
