export type Turn = { who: "c" | "a"; body: string };
export type Scenario = {
  key: string;
  subject: string;
  topic: string;
  tags: string[];
  priority: "low" | "normal" | "high" | "urgent";
  sentiment: "positive" | "neutral" | "negative";
  channelPref?: "email" | "widget" | "discord" | "slack" | "whatsapp" | "telegram";
  turns: Turn[];
  note?: string;
  reuse?: boolean;
};
export const SCENARIOS: Scenario[] = [
  {
    key: "sso-saml-login-loop",
    subject: "SAML login just bounces me back to the login screen",
    topic: "security",
    tags: ["sso", "saml"],
    priority: "high",
    sentiment: "negative",
    turns: [
      { who: "c", body: "we set up SSO with Okta yesterday and now nobody on the team can get in. you click Login with SSO, it goes to Okta, we authenticate fine, then it drops us right back on your login page. no error, nothing. this is blocking about 40 people." },
      { who: "a", body: "Sorry about that, a redirect loop like this is almost always a mismatch on the ACS URL or the audience/entity ID. Can you confirm two things in Okta: the SSO URL is set to https://app.acme.com/auth/saml/callback and the Audience URI matches exactly what we show on your SSO settings page? A trailing slash difference is the usual culprit." },
      { who: "c", body: "the audience had a trailing slash in okta that wasnt on your side. removed it and we're in. thank you, that was driving us nuts" },
      { who: "a", body: "Perfect, glad that was it. Trailing slashes on the Audience URI catch a lot of people. I've made a note on your account in case you add another IdP later. Have a good one!" }
    ],
    note: "Redirect loop = Audience URI trailing slash mismatch in Okta. Common, worth a KB article.",
    reuse: false
  },
  {
    key: "invoice-missing-vat",
    subject: "Invoice doesn't show our VAT number",
    topic: "billing",
    tags: ["invoice", "tax"],
    priority: "normal",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "Hi, our finance team needs our VAT ID printed on the monthly invoices for it to be deductible here. The last two invoices don't have it. Can you add it?" },
      { who: "a", body: "Absolutely. If you add the VAT ID under Settings > Billing > Tax details, it will appear on all future invoices automatically. I can also reissue the last two invoices with the VAT ID included once you've saved it, just let me know." },
      { who: "c", body: "added it. yes please reissue the last two." },
      { who: "a", body: "Done, both invoices have been reissued with your VAT ID and emailed to your billing contact. The originals are voided so your finance team should only use the new PDFs." }
    ],
    reuse: true
  },
  {
    key: "api-rate-limit-429",
    subject: "Getting 429s on /v2/events during our nightly sync",
    topic: "api",
    tags: ["api", "rate-limit"],
    priority: "high",
    sentiment: "negative",
    channelPref: "slack",
    turns: [
      { who: "c", body: "our nightly job hammers /v2/events and we started getting 429 Too Many Requests around 2am. it was fine last week. did the limits change?" },
      { who: "a", body: "The default limit on /v2/events is 600 req/min per token and that hasn't changed, but your volume likely crossed it as your data grew. Two options: batch your writes (the endpoint accepts up to 500 events per POST) or we can raise your limit on the Growth plan. Are you sending one event per request right now?" },
      { who: "c", body: "yeah one per request, thats probably it. we can batch." },
      { who: "a", body: "Batching will fix it and also cut your request count massively. Respect the Retry-After header if you ever do hit the ceiling. I bumped your limit to 1000/min for tonight as a buffer while you ship the batching change." }
    ],
    note: "Sending 1 event/request. Recommended batch endpoint. Temp bumped limit to 1000/min.",
    reuse: false
  },
  {
    key: "webhook-retries-failing",
    subject: "Webhooks stopped delivering — seeing them queue up",
    topic: "integration",
    tags: ["webhooks", "integration"],
    priority: "high",
    sentiment: "negative",
    turns: [
      { who: "c", body: "our webhook endpoint hasn't received anything since about 9am and the delivery log on your side shows a growing backlog. our server is up and responding to health checks fine." },
      { who: "a", body: "Looking at your delivery log I see we're getting 500s back from your endpoint, not timeouts, so from our side the endpoint is reachable but erroring. We retry with backoff for 24h before pausing. Can you check your logs around 09:00 for what changed? A deploy maybe?" },
      { who: "c", body: "ugh you're right, we shipped something at 8:55 that broke the handler. fixing now. will the queued ones redeliver?" },
      { who: "a", body: "Yes, everything in the backlog will retry automatically once your endpoint starts returning 2xx again. If you'd rather force an immediate flush after your fix is live, hit Replay all in the webhook dashboard. No events are lost." }
    ],
    note: "Their deploy broke the handler, we were returning their 500s. Backlog will self-heal on 2xx.",
    reuse: false
  },
  {
    key: "slack-notifications-stopped",
    subject: "Slack alerts went quiet",
    topic: "integration",
    tags: ["slack", "notifications"],
    priority: "normal",
    sentiment: "neutral",
    channelPref: "slack",
    turns: [
      { who: "c", body: "our #alerts channel used to get a ping whenever a report finished. nothing for 3 days now." },
      { who: "a", body: "That usually means the Slack token got revoked, often when a workspace admin removes an app or someone leaves. Can you go to Settings > Integrations > Slack and check if it says Connected or Reconnect required?" },
      { who: "c", body: "it says reconnect required. reconnected and got a test ping. cheers" }
    ],
    reuse: false
  },
  {
    key: "salesforce-duplicate-records",
    subject: "Salesforce sync is creating duplicate contacts",
    topic: "integration",
    tags: ["salesforce", "sync"],
    priority: "high",
    sentiment: "negative",
    turns: [
      { who: "c", body: "since we turned on the Salesforce integration we're getting duplicate Contact records in SF for the same person. dedupe is a nightmare. what matching key does your sync use?" },
      { who: "a", body: "By default the connector matches on email. If your Salesforce has contacts with blank or differently-cased emails, it can't match them and creates new ones. Two fixes: set the matching field to a Salesforce External ID (recommended) under Integrations > Salesforce > Field Mapping, or enable Fuzzy match on name+email. Which would you prefer?" },
      { who: "c", body: "we do have an external id field. lets use that." },
      { who: "a", body: "Great. Point the matching field at your External ID and future syncs will upsert instead of insert. For the dupes already created, I can send you a SOQL query to identify them by our sync tag so your team can merge them in bulk. Want that?" },
      { who: "c", body: "yes please send the query" },
      { who: "a", body: "Sent it to your email. It filters on the acme_synced__c flag and groups by external ID so you get a clean dupe list. Once you've merged, run a manual resync and it'll stay clean going forward." }
    ],
    note: "Matching on email, customer had blank emails in SF. Switched to External ID. Sent dedupe SOQL.",
    reuse: false
  },
  {
    key: "zapier-zap-not-triggering",
    subject: "New row Zap never fires",
    topic: "integration",
    tags: ["zapier"],
    priority: "normal",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "built a zap: when a new record is created in acme, add a row to google sheets. test step works but live it never triggers." },
      { who: "a", body: "Zapier's polling triggers only pick up records created after the Zap was turned on, and they poll every 1-15 min depending on your Zapier plan. Can you create one brand new record and give it up to 15 minutes? If it still doesn't fire, check that the Zap is toggled On (not just saved)." },
      { who: "c", body: "it was saved but not turned on. classic. working now, thanks" }
    ],
    reuse: false
  },
  {
    key: "csv-import-timeout",
    subject: "Large CSV import keeps failing at ~80%",
    topic: "data",
    tags: ["import", "csv"],
    priority: "high",
    sentiment: "negative",
    turns: [
      { who: "c", body: "trying to import a 240k row customer file and it gets to roughly 80% then throws Import failed, please try again. tried 3 times. the file is clean utf-8, we validated it." },
      { who: "a", body: "A stall near the end on a file that size usually means one malformed row is hitting a validation error and rolling the batch back rather than a real timeout. Can you turn on Skip invalid rows in the import dialog and try once more? It'll finish and hand you a downloadable report of the rows it skipped so you can see exactly what's failing." },
      { who: "c", body: "did that, it finished. skipped 11 rows, all had a bad date format in the signup_date column. we'll fix those and reimport them. appreciate it" },
      { who: "a", body: "That'll do it, our date parser wants ISO 8601 (YYYY-MM-DD). Fix those 11 and reimport just that subset. Glad the rest is in." }
    ],
    note: "Not a timeout — 11 rows with non-ISO dates rolled back the batch. Skip-invalid + report solved it.",
    reuse: false
  },
  {
    key: "csv-export-empty-file",
    subject: "Export gives me an empty file",
    topic: "data",
    tags: ["export", "csv"],
    priority: "normal",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "when i export the tickets view to csv i get a file with just the header row, no data. there are definitely hundreds of rows on screen." },
      { who: "a", body: "The export respects your active filters and, importantly, your date range. If the view has a saved filter scoped to a range with no matches in the export window, you'll get headers only. Can you tell me if there's a date filter chip active above the table?" },
      { who: "c", body: "there was a last 7 days filter i forgot about. cleared it and the export has everything now" }
    ],
    reuse: false
  },
  {
    key: "dashboard-numbers-mismatch",
    subject: "Q3 revenue dashboard doesn't match our books",
    topic: "data",
    tags: ["data", "accuracy"],
    priority: "high",
    sentiment: "negative",
    turns: [
      { who: "c", body: "the Q3 revenue dashboard shows about 12k more than what our finance team has in the actual ledger. leadership is asking which number is right and I need to explain the gap. can you help me reconcile?" },
      { who: "a", body: "Happy to dig in. The most common source of this gap is timezone: our dashboards aggregate in UTC by default, so transactions near midnight can land in a different day (and quarter boundary) than your local books. What timezone is your finance team using, and is your workspace timezone set to match?" },
      { who: "c", body: "we're in America/Chicago and the workspace is on UTC. so anything after 7pm central on sept 30 rolled into q4 for us but q3 in your view?" },
      { who: "a", body: "Exactly right, that boundary effect explains a gap of roughly that size. Set the workspace timezone to America/Chicago under Settings > General, then the dashboard will re-aggregate and the quarter cutoffs will line up with your ledger. The underlying data is identical, it's purely the bucketing." },
      { who: "c", body: "changed it and the numbers reconcile now within a few dollars (rounding). huge relief, thank you for walking me through it" },
      { who: "a", body: "Perfect. The few dollars is rounding on partial refunds, that's expected. I'll leave you a doc link on how timezone affects period reporting so you can share it with finance." }
    ],
    note: "Classic UTC vs local quarter-boundary. Not a bug. Workspace was on UTC, finance on CT. Fixed by TZ.",
    reuse: false
  },
  {
    key: "everything-is-down",
    subject: "EVERYTHING IS DOWN",
    topic: "outage",
    tags: ["outage"],
    priority: "urgent",
    sentiment: "negative",
    channelPref: "widget",
    turns: [
      { who: "c", body: "the whole app is throwing a 503 for our entire team. we have a board demo in 40 minutes. what is going on??" },
      { who: "a", body: "I'm on it. We are seeing elevated errors in one region and engineering is already engaged, our status page is updating live at status.acme.com. Can you tell me roughly where your team is located so I can confirm you're on the affected region?" },
      { who: "c", body: "we're all in the EU" },
      { who: "a", body: "That's the region with the incident, mitigation is rolling out now and we expect recovery within ~15 minutes, ahead of your demo. As a fallback, the US endpoint is unaffected if you need to log in via app-us.acme.com in the meantime. I'll message you here the moment it's fully green." },
      { who: "c", body: "back up now. that was scary but you kept me sane, thanks" },
      { who: "a", body: "Recovery confirmed across the EU region and error rates are back to baseline. Good luck with the board demo, and a full incident writeup will be posted on the status page within 24h." }
    ],
    note: "EU region 503 incident. Steered to US endpoint as fallback. Postmortem owed on status page.",
    reuse: false
  },
  {
    key: "dashboard-slow-load",
    subject: "Dashboards take 20+ seconds to load",
    topic: "performance",
    tags: ["performance", "dashboard"],
    priority: "high",
    sentiment: "negative",
    turns: [
      { who: "c", body: "our main ops dashboard has gotten really slow, like 20-30 seconds to render. it was snappy a couple months ago. we've added a few widgets since then but this feels excessive." },
      { who: "a", body: "A dashboard that's degraded over time is usually one or two heavy widgets, typically a table widget with no row limit or a chart querying a very wide date range unfiltered. If you open the dashboard and click the timer icon in the top right, it shows per-widget load times. Can you tell me which widget is the slowest?" },
      { who: "c", body: "the unfiltered events table is 18 seconds by itself. everything else is under a second." },
      { who: "a", body: "There's the bottleneck. That table is pulling every event with no bound. Add a date filter (last 30 days) and a row limit, or convert it to a summarized chart if you don't need the raw rows. Either drops it to well under a second and the whole dashboard will feel instant again." }
    ],
    note: "Unfiltered events table widget = 18s. Advised date filter + row cap.",
    reuse: false
  },
  {
    key: "remove-seat-billing",
    subject: "Removed a user but still being charged for them",
    topic: "billing",
    tags: ["billing", "seats"],
    priority: "normal",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "we removed someone from the team last week but our seat count still shows 12 and we're on 11 people now. will the next invoice reflect the drop?" },
      { who: "a", body: "Removing a user frees the seat immediately, but on annual plans the seat count doesn't reduce mid-term, you keep the paid seats until renewal and the freed seat is available to reassign at no cost. On monthly plans it prorates down next cycle. You're on annual, so that extra seat is yours to reassign until renewal. Want me to confirm your renewal date?" },
      { who: "c", body: "ah okay that makes sense, no need. we'll just reassign it. thanks" }
    ],
    reuse: true
  },
  {
    key: "password-reset",
    subject: "Can't reset my password",
    topic: "account",
    tags: ["password", "login"],
    priority: "normal",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "i requested a password reset three times and no email ever arrives. checked spam. i'm locked out." },
      { who: "a", body: "Sorry about that. Two quick things: reset emails come from no-reply@acme.com, and if your org has SSO enforced, password login is disabled and the reset email is intentionally suppressed. Does your company log in via Google or Okta normally? If so, use the Login with SSO button instead of a password." },
      { who: "c", body: "oh we do use google sso. i've just been clicking the wrong button this whole time. i'm in now, sorry" },
      { who: "a", body: "No trouble at all, that catches people constantly. Glad you're in." }
    ],
    reuse: true
  },
  {
    key: "2fa-locked-out",
    subject: "Lost my phone, locked out by 2FA",
    topic: "security",
    tags: ["2fa", "account"],
    priority: "high",
    sentiment: "negative",
    turns: [
      { who: "c", body: "i got a new phone and didn't move my authenticator app over. now i can't log in because it wants my 2FA code and i don't have it. help please, i'm an admin and need to get in today." },
      { who: "a", body: "Let's get you back in. Do you still have the backup codes you were shown when you enabled 2FA? Any one of them works in place of the app code. If you don't have those, I can start our identity verification process to reset your 2FA, that requires confirming ownership of the account email plus a second factor for security." },
      { who: "c", body: "no backup codes, never saved them. how does the verification work" },
      { who: "a", body: "I've emailed a verification link to your account address, click it and confirm the one-time code we send, and I'll clear the 2FA enrollment so you can log in and re-register your authenticator. Please save your new backup codes this time. Once you're in, an org owner can also reset 2FA for teammates without contacting us." }
    ],
    note: "No backup codes. Ran email-based identity verification to clear 2FA. Reminded to save backup codes.",
    reuse: false
  },
  {
    key: "gdpr-data-deletion",
    subject: "GDPR erasure request for a customer",
    topic: "security",
    tags: ["gdpr", "privacy"],
    priority: "high",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "one of our end users has filed a right-to-erasure request under GDPR. we need all of their personal data removed from your systems and confirmation in writing for our records. how do we do this and what's the timeline?" },
      { who: "a", body: "We support this fully. You can trigger a hard delete yourself via Settings > Privacy > Data Subject Requests by entering the person's email, that queues a permanent deletion across primary storage and backups (backups purge on their 30-day rotation). We'll email you a signed completion certificate for your records. If you'd rather we process it, send me the email address and I'll run it under our DPA." },
      { who: "c", body: "please process it on your end. the email is on file under our account, i'll DM it. and yes we need the certificate for our compliance folder." },
      { who: "a", body: "Received and initiated. Primary data is erased now and I've logged the request against your DPA. The signed completion certificate is on its way to your account email, and it notes the backup purge completes within 30 days. Let me know if your DPO needs anything further." }
    ],
    note: "GDPR erasure processed under DPA. Certificate sent. Backups purge on 30d rotation — noted on cert.",
    reuse: false
  },
  {
    key: "feature-request-dark-mode",
    subject: "Please add dark mode 🙏",
    topic: "feature",
    tags: ["feature", "ui"],
    priority: "low",
    sentiment: "positive",
    channelPref: "discord",
    turns: [
      { who: "c", body: "love the product, been using it daily. any chance of a dark mode? my eyes are begging by 6pm" },
      { who: "a", body: "Ha, we hear you, and you're not alone, it's one of our most requested items. It's on the roadmap but I won't promise a date. I've added your vote so it carries weight with the product team. If it helps tonight, most OS-level dark reader extensions play nicely with our app in the meantime." },
      { who: "c", body: "amazing, thanks for the honest answer. i'll try the extension trick" }
    ],
    note: "Dark mode +1. Logged vote.",
    reuse: false
  },
  {
    key: "cancel-subscription",
    subject: "Cancelling our subscription",
    topic: "account",
    tags: ["cancellation", "billing"],
    priority: "high",
    sentiment: "negative",
    turns: [
      { who: "c", body: "we've decided to cancel. honestly the reporting side never worked well for us and we've moved to another tool. please cancel effective end of term and don't auto-renew." },
      { who: "a", body: "I'm sorry to hear that, and thank you for being direct about the reporting, that's genuinely useful for us. I've turned off auto-renewal so you won't be charged again; you keep full access until your term ends. If you're open to it, I'd love 10 minutes to understand what fell short on reporting, no sales pitch, just so we fix it. Either way your cancellation is handled." },
      { who: "c", body: "i appreciate that. i might take you up on the call. the main thing was scheduled reports never arriving reliably and no way to build a custom metric without your help." },
      { who: "a", body: "Both of those are fair and both are things we've been actively working on. I'll pass this straight to the product lead. Your access runs through end of term and there's nothing else you need to do. If the new tool doesn't stick, we'd welcome you back, no restart friction." }
    ],
    note: "Churn: reporting reliability + no self-serve custom metrics. Auto-renew off, access to term end. Feedback to product.",
    reuse: false
  },
  {
    key: "renewal-upgrade-growth",
    subject: "Upgrading to Growth before renewal",
    topic: "billing",
    tags: ["upgrade", "renewal"],
    priority: "normal",
    sentiment: "positive",
    turns: [
      { who: "c", body: "we're growing and want to move from Starter to the Growth plan, mainly for the higher API limits and more seats. our renewal is next month. is it better to upgrade now or wait, and how does the billing work?" },
      { who: "a", body: "Great news that you're scaling. You can upgrade today, we prorate: you're credited for the unused Starter time and only pay the difference to Growth for the remainder of your term, then it renews at the full Growth rate next month. Upgrading now means you get the higher API limits and seats immediately. Want me to apply it, or send a quote first?" },
      { who: "c", body: "send a quote first so i can get it approved, then i'll come back to apply it" },
      { who: "a", body: "Sent, it's in your inbox and itemizes the prorated charge plus the go-forward Growth rate. It's valid for 30 days. Reply here or reopen this thread when you're ready and I'll flip the plan the same day." }
    ],
    note: "Upsell Starter to Growth, wants quote for approval first. Quote sent, 30d valid.",
    reuse: false
  },
  {
    key: "proration-confusing",
    subject: "Confused by the proration on this invoice",
    topic: "billing",
    tags: ["billing", "proration"],
    priority: "normal",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "this month's invoice has three line items and i genuinely can't tell what i'm being charged for. there's a credit, a charge, and the normal subscription. can you break it down?" },
      { who: "a", body: "Of course, this happens when a plan changes mid-cycle. The credit is us refunding the unused portion of your old plan, the separate charge is the prorated cost of the new plan for the days remaining in that cycle, and the third line is your normal go-forward subscription. Net, you paid only for what you actually used on each. I can send an annotated copy that labels each line if that helps finance." },
      { who: "c", body: "yes an annotated copy would be perfect for finance, thanks for explaining" }
    ],
    reuse: true
  },
  {
    key: "refund-double-charge",
    subject: "We were charged twice this month",
    topic: "billing",
    tags: ["refund", "billing"],
    priority: "high",
    sentiment: "negative",
    turns: [
      { who: "c", body: "our card was charged twice for the same subscription on the 3rd. two identical charges. we need one refunded asap, this hit our accounting." },
      { who: "a", body: "Apologies, a double charge is on us to fix immediately. I can see the two identical transactions on the 3rd, the second was a retry that shouldn't have captured. I've refunded it in full just now; it typically lands back on your card in 5-10 business days depending on your bank. I'll email you the refund confirmation for your records." },
      { who: "c", body: "thank you for the quick fix. got the confirmation email." },
      { who: "a", body: "You're welcome, and sorry for the scare. I've also flagged the duplicate-retry on our side so it doesn't recur. Have a good one." }
    ],
    note: "Payment retry double-captured. Refunded 2nd charge. Flagged retry bug to payments.",
    reuse: false
  },
  {
    key: "onboarding-first-dashboard",
    subject: "How do I build my first dashboard?",
    topic: "onboarding",
    tags: ["onboarding", "dashboard"],
    priority: "low",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "just signed up, poking around. how do i actually build a dashboard from scratch? not sure where to start." },
      { who: "a", body: "Welcome aboard! Quickest path: click New Dashboard (top right), then Add widget and pick a chart type, each widget asks for a data source and a metric. If you'd rather not start blank, the Templates gallery has prebuilt Revenue, Activity, and Funnel dashboards you can clone and edit. I'd start with a template and tweak from there. Want a link to a 4-minute setup walkthrough?" },
      { who: "c", body: "yes please, and i'll try the revenue template" },
      { who: "a", body: "Sent the walkthrough. The Revenue template is a great first pick, clone it, point the widgets at your data source, and you'll have a live dashboard in a couple minutes. Shout if any widget looks empty and I'll help you map the source." }
    ],
    reuse: true
  },
  {
    key: "howto-invite-teammates",
    subject: "How do I invite my team?",
    topic: "howto",
    tags: ["howto", "seats"],
    priority: "low",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "how do i add my coworkers to the account?" },
      { who: "a", body: "Go to Settings > Members > Invite, enter their emails and pick a role (Admin, Editor, or Viewer). They'll get an email invite. Heads up: invites count against your seat count, you're currently using a few of your available seats, so you've got room. Want me to confirm how many seats are free?" },
      { who: "c", body: "nah i can see it now, thanks!" }
    ],
    reuse: true
  },
  {
    key: "api-key-401",
    subject: "API returns 401 even with a valid key",
    topic: "api",
    tags: ["api", "auth"],
    priority: "high",
    sentiment: "negative",
    turns: [
      { who: "c", body: "every request to your API returns 401 unauthorized. i copied the key straight from the dashboard. i'm passing it as Authorization: my_key. what am i doing wrong?" },
      { who: "a", body: "Close! The header needs the Bearer prefix: Authorization: Bearer <your_key>. A raw key without Bearer returns exactly this 401. Also double-check you're using a Secret key (starts with sk_) and not the Publishable key (pk_), the pk_ key only works for client-side reads. Give the Bearer prefix a try?" },
      { who: "c", body: "that was it, missing Bearer. of course. working now, thank you" }
    ],
    note: "Missing Bearer prefix. Recurs constantly — maybe surface in API docs error hint.",
    reuse: false
  },
  {
    key: "webhook-signature-verification",
    subject: "How do I verify webhook signatures?",
    topic: "api",
    tags: ["webhooks", "security"],
    priority: "normal",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "security review is asking us to verify the signature on incoming webhooks so we know they're really from you. how does your signing work?" },
      { who: "a", body: "Every webhook includes an X-Acme-Signature header, which is an HMAC-SHA256 of the raw request body using your webhook signing secret (found under Settings > Webhooks > Signing secret). Compute the HMAC over the exact raw bytes, before any JSON parsing, and compare with a constant-time equality check. We've got copy-paste snippets for Node, Python, and Go in the docs. Want the links?" },
      { who: "c", body: "yes send the snippets. and just to confirm, hmac over the raw body not the parsed json?" },
      { who: "a", body: "Correct, the raw body exactly as received; re-serializing parsed JSON will change the bytes and break the check. That's the number one gotcha. Snippets sent, the Node one uses express.raw() specifically to preserve the body." }
    ],
    reuse: false
  },
  {
    key: "timezone-report-off-by-day",
    subject: "Scheduled report is a day behind",
    topic: "bug",
    tags: ["reporting", "timezone"],
    priority: "normal",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "our daily report that's supposed to summarize yesterday is consistently showing the day before yesterday. so today's report covers two days ago, not yesterday. it's off by one." },
      { who: "a", body: "That points to a timezone mismatch between when the report runs and how its date window is defined. If the schedule fires at, say, 6am UTC but your data window is defined in your local timezone which is behind UTC, yesterday hasn't fully closed yet when it runs. What time is the report scheduled, and what timezone is the workspace set to?" },
      { who: "c", body: "scheduled 6am, workspace is on UTC, but we're in Los Angeles. so at 6am UTC it's still yesterday evening here." },
      { who: "a", body: "Exactly. Set the workspace (or the report) timezone to America/Los_Angeles and the yesterday window will close correctly before the 6am run in your local time. Alternatively push the schedule to 9am UTC. The timezone fix is the clean one." }
    ],
    note: "Off-by-one = report window in local TZ but workspace UTC, ran before yesterday closed locally.",
    reuse: false
  },
  {
    key: "email-deliverability-spam",
    subject: "Our report emails are landing in spam",
    topic: "integration",
    tags: ["email", "deliverability"],
    priority: "normal",
    sentiment: "negative",
    turns: [
      { who: "c", body: "the scheduled reports you email out are going to our recipients' spam folders about half the time. we use a custom from-address on our domain. how do we fix this?" },
      { who: "a", body: "When you send report emails from your own domain, mailbox providers want to see that you've authorized us to send on your behalf, otherwise they get flagged. You'll need to add the SPF include and DKIM CNAME records we provide under Settings > Email > Sending Domain, then click Verify. Once those are green, deliverability jumps. Want me to paste your exact records?" },
      { who: "c", body: "yes paste them, our IT can add them today" },
      { who: "a", body: "Sent your three records (one SPF include, two DKIM CNAMEs) to this thread. After IT adds them, hit Verify, DNS can take up to an hour to propagate. Once verified, spam placement should clear up within a day or two as reputation builds." }
    ],
    note: "Custom sending domain not authenticated. Sent SPF/DKIM records.",
    reuse: false
  },
  {
    key: "mobile-app-crash-on-open",
    subject: "iOS app crashes immediately on open",
    topic: "bug",
    tags: ["mobile", "crash"],
    priority: "high",
    sentiment: "negative",
    channelPref: "whatsapp",
    turns: [
      { who: "c", body: "the iphone app crashes the second i open it since the last update. android is fine. i'm on ios 17." },
      { who: "a", body: "Sorry about that, we've had a couple of reports of a crash on launch tied to a corrupted local cache after the update. Quick fix that's worked for everyone so far: delete and reinstall the app (your data is all server-side, nothing is lost). Can you try that and let me know?" },
      { who: "c", body: "reinstalled and it opens fine now. weird but ok" },
      { who: "a", body: "Glad it's back. The reinstall clears the bad cache. We're shipping a patch this week so no one has to do that, thanks for the report, it helped confirm it." }
    ],
    note: "Launch crash from corrupt local cache post-update. Reinstall clears it. Patch in flight.",
    reuse: false
  },
  {
    key: "safari-charts-blank",
    subject: "Charts show blank in Safari",
    topic: "bug",
    tags: ["browser", "charts"],
    priority: "normal",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "half my charts render as empty boxes in safari. same dashboard is fine in chrome. weird." },
      { who: "a", body: "Blank chart boxes in Safari specifically are almost always a content blocker or the Prevent cross-site tracking setting interfering with our chart renderer. Can you try loading the dashboard in a Safari private window, or temporarily disabling any ad/content blocker for app.acme.com? If it renders then, we know the culprit." },
      { who: "c", body: "private window works. it's my adblock. i'll allowlist you. thanks" }
    ],
    reuse: false
  },
  {
    key: "role-permissions-cant-edit",
    subject: "Editor can't edit dashboards?",
    topic: "account",
    tags: ["permissions", "roles"],
    priority: "normal",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "i gave a teammate the Editor role but they say they can't change the shared team dashboards, only their own. is that expected?" },
      { who: "a", body: "It is, and it's a common point of confusion. The Editor role can create and edit their own content, but shared team dashboards are governed by per-dashboard sharing, the dashboard owner has to grant Can edit to that person or to a group. Open the dashboard, click Share, and set their access to Can edit. Want me to walk through it on a specific one?" },
      { who: "c", body: "got it, found the share settings and gave them edit. makes sense now" }
    ],
    reuse: false
  },
  {
    key: "seat-count-wrong",
    subject: "Seat count looks wrong",
    topic: "billing",
    tags: ["seats", "billing"],
    priority: "normal",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "the billing page says we have 15 seats in use but i count 13 actual people. where are the extra 2 coming from?" },
      { who: "a", body: "Two likely sources: pending invites count as consumed seats until accepted or revoked, and deactivated-but-not-removed users can still hold a seat. Check Members and look for anyone with a Pending or Deactivated badge, revoke pending invites you no longer need and fully remove deactivated users, and the count will drop to 13." },
      { who: "c", body: "yep, 2 pending invites from months ago. revoked them, now it's 13. thanks" }
    ],
    reuse: false
  },
  {
    key: "revenue-data-discrepancy-integration",
    subject: "Revenue numbers don't match our payment provider",
    topic: "data",
    tags: ["data", "integration"],
    priority: "high",
    sentiment: "negative",
    turns: [
      { who: "c", body: "your revenue metric is about 6% lower than what our Stripe dashboard reports for the same period. we pipe Stripe events into acme via the integration. where's the leak?" },
      { who: "a", body: "A consistent 6% gap usually isn't lost data, it's a definition difference. Two common ones: our revenue metric can be net of refunds and fees while Stripe's headline figure is gross, and currency conversion, if you have multi-currency charges, we normalize to your workspace currency at event time while Stripe may show settlement-time rates. Are you comparing against Stripe's gross volume or net?" },
      { who: "c", body: "we were looking at gross volume in stripe. so your number being net of refunds would explain a chunk of it." },
      { who: "a", body: "Right, compare against Stripe's Net volume and the bulk should close. Any residual is the FX timing difference. If you'd like an apples-to-apples check, I can enable the Gross revenue metric variant on your workspace so you can toggle between gross and net and see them reconcile side by side." }
    ],
    note: "6% gap = comparing our net vs Stripe gross + FX timing. Offered gross metric variant to reconcile.",
    reuse: false
  },
  {
    key: "scheduled-report-not-sending",
    subject: "Weekly report just stopped sending",
    topic: "bug",
    tags: ["reporting", "scheduling"],
    priority: "normal",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "our monday morning exec report hasn't gone out for two weeks. it used to be reliable. nothing changed on our end that i know of." },
      { who: "a", body: "Let me check. One thing that silently stops a schedule: if the report's owner was deactivated or lost access to the underlying data source, the send fails quietly. Did anyone who set up or owned that report leave recently, or change roles?" },
      { who: "c", body: "actually yes, the person who built it left the company two weeks ago and we deactivated them. that lines up exactly." },
      { who: "a", body: "That's it. The schedule was tied to their access. Reassign the report owner to an active user with access to the data source (edit the report > Owner), and it'll resume next Monday. I'd also suggest owning shared schedules with a team/service account rather than an individual to avoid this. Want me to reassign it for you now?" }
    ],
    note: "Silent schedule failure — owner was deactivated. Recommend team-owned schedules.",
    reuse: false
  },
  {
    key: "scim-provisioning-not-working",
    subject: "SCIM provisioning isn't creating users",
    topic: "security",
    tags: ["scim", "sso"],
    priority: "high",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "we configured SCIM from Azure AD to auto-provision users. assignments in azure aren't showing up as users in acme. sso login works fine though." },
      { who: "a", body: "Good sign that SSO works, that means your SAML is solid and this is isolated to the SCIM connector. The usual cause is the SCIM token or tenant URL being off, or the Azure provisioning job not having run a cycle yet (it can take up to 40 minutes). Can you check in Azure > Provisioning that the last cycle succeeded, and confirm the SCIM base URL you entered ends in /scim/v2?" },
      { who: "c", body: "the base url was missing the /v2 at the end. fixed it and ran a provision-on-demand for one user, they appeared in acme. running the full sync now." },
      { who: "a", body: "That'll do it. Let the full cycle complete, deprovisioning (removing an Azure assignment) will also deactivate the seat in acme automatically now that the connector's talking. Reach out if any user maps to the wrong role, that's controlled by your group-to-role mapping." }
    ],
    note: "SCIM base URL missing /v2. SSO worked, SCIM didn't — good isolation signal.",
    reuse: false
  },
  {
    key: "api-pagination-howto",
    subject: "How do I paginate through all records?",
    topic: "howto",
    tags: ["api", "pagination"],
    priority: "low",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "the /v2/records endpoint only returns 100 results. how do i get all of them?" },
      { who: "a", body: "We use cursor-based pagination. Each response includes a has_more boolean and a next_cursor. Pass that value as the cursor query param on your next request and keep going until has_more is false. Avoid offset-style paging, cursors are stable even as new records come in. There's a loop example in the docs; want the link?" },
      { who: "c", body: "cursor makes sense, no need for the link, i've got it. thanks" }
    ],
    reuse: true
  },
  {
    key: "slack-connect-oauth-error",
    subject: "Slack connect fails with an OAuth error",
    topic: "integration",
    tags: ["slack", "oauth"],
    priority: "normal",
    sentiment: "negative",
    channelPref: "discord",
    turns: [
      { who: "c", body: "trying to connect slack and i get invalid_scope on the oauth screen. can't get past it." },
      { who: "a", body: "invalid_scope on connect usually means a Slack workspace admin has restricted which apps can be installed, so our requested scopes are being denied. Can you check with your Slack admin whether app approval is required in your workspace? If so they'll need to approve Acme (or pre-approve it), then the connect flow will succeed." },
      { who: "c", body: "yeah our workspace requires admin approval. got them to approve it and it connected. thanks for pointing me the right way" }
    ],
    reuse: false
  },
  {
    key: "api-500-outage",
    subject: "API throwing 500s across the board",
    topic: "outage",
    tags: ["outage", "api"],
    priority: "urgent",
    sentiment: "negative",
    turns: [
      { who: "c", body: "every call to your API is returning 500 for the last ten minutes. our production pipeline depends on this. is there an incident?" },
      { who: "a", body: "Yes, we've just opened an incident, a database failover is causing elevated 500s on write endpoints. Engineering is actively mitigating and status.acme.com is tracking it live. Reads should be recovering first. I'll update this thread the moment writes are stable." },
      { who: "c", body: "ok. our pipeline will retry so as long as it's minutes not hours we're okay." },
      { who: "a", body: "Understood, and your retries are the right call, our endpoints are idempotent on the same request ID so duplicate retries won't double-write. Writes are recovering now and 500 rates are dropping toward baseline. I'll confirm all-clear shortly and the postmortem will be public within 24h." }
    ],
    note: "DB failover caused 500s on writes. Reassured idempotency handles their retries. Postmortem owed.",
    reuse: false
  },
  {
    key: "winback-cancelled-customer",
    subject: "Re: your subscription ended",
    topic: "account",
    tags: ["winback", "renewal"],
    priority: "low",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "we let our plan lapse a couple months ago when budgets got cut. we might be back in a position to use acme again. is our old data still around or do we start from zero?" },
      { who: "a", body: "Welcome back, potentially! Good news: we retain workspace data for 90 days after a plan ends, and you're within that window, so if you reactivate now everything (dashboards, integrations, historical data) comes right back exactly as you left it. After 90 days it's purged. Want me to send a reactivation link, and is the old plan still the right fit or has your team size changed?" },
      { who: "c", body: "team's a bit bigger now, maybe 5 more people. send the link and i'll look at the growth plan sizing" },
      { who: "a", body: "Sent. Reactivating restores your workspace instantly; you can bump the plan and seats during checkout, so size it for the bigger team right away. If you want a quick call to right-size before you commit, happy to set one up, no pressure either way." }
    ],
    note: "Lapsed customer within 90d retention window — data restorable. Team grew ~5. Winback + upsell.",
    reuse: false
  },
  {
    key: "enterprise-upgrade-quote",
    subject: "Interested in Enterprise / SSO enforcement",
    topic: "billing",
    tags: ["upgrade", "enterprise"],
    priority: "normal",
    sentiment: "positive",
    turns: [
      { who: "c", body: "our security team wants enforced SSO, audit logs, and a signed DPA before we roll acme out company-wide. i think that's your Enterprise tier? can you tell me what's included and rough pricing for ~200 seats?" },
      { who: "a", body: "Yes, enforced SSO, full audit-log export, SCIM, custom data retention, and a signed DPA are all Enterprise features. Pricing at 200 seats is volume-based so I'd rather quote it accurately than guess, I can loop in our team to prep a proposal and answer the security questionnaire in one go. What's your target timeline for the rollout?" },
      { who: "c", body: "we'd want to go live start of next quarter, so we have some runway. a proposal + security questionnaire support would be ideal." },
      { who: "a", body: "Perfect, that timeline is comfortable. I've flagged this for our team to prepare an Enterprise proposal and they'll reach out to coordinate the security review and DPA. In the meantime I can share our SOC 2 report and a security overview doc so your team can start their assessment, want those now?" }
    ],
    note: "Enterprise lead, 200 seats, enforced SSO/audit/DPA. Rollout target next quarter. Flagged to sales.",
    reuse: false
  },
  {
    key: "custom-domain-setup",
    subject: "How to set up a custom domain for shared dashboards",
    topic: "howto",
    tags: ["howto", "domain"],
    priority: "low",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "we want our shared/public dashboards to live on dashboards.ourcompany.com instead of the acme url. possible?" },
      { who: "a", body: "Yes, on Growth and above. Go to Settings > Custom Domain, enter dashboards.ourcompany.com, and we'll give you a CNAME to add at your DNS provider pointing to cname.acme.com. Once it verifies we auto-provision an SSL cert. Public dashboard links then serve from your domain. Want the exact CNAME target now?" },
      { who: "c", body: "yep give me the target and i'll set the dns" },
      { who: "a", body: "Add a CNAME for dashboards.ourcompany.com pointing to cname.acme.com, then click Verify in the same settings page. SSL provisions automatically within a few minutes of verification. Ping me if Verify stays pending past an hour, that's just DNS propagation, but I'll check it looks right." }
    ],
    reuse: false
  },
  {
    key: "2fa-backup-codes-howto",
    subject: "Where are my 2FA backup codes?",
    topic: "security",
    tags: ["2fa", "account"],
    priority: "low",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "i want to save my two-factor backup codes but i can't find where they are now that 2fa is already on." },
      { who: "a", body: "You can regenerate them anytime: Settings > Security > Two-factor authentication > Regenerate backup codes. Note that regenerating invalidates any old set, so save the new ones somewhere safe (a password manager is ideal). Each code works once. Want the direct link?" },
      { who: "c", body: "found it, regenerated and saved them in 1password. thanks" }
    ],
    reuse: true
  },
  {
    key: "dashboard-widget-wrong-total",
    subject: "Bar chart widget totals don't add up",
    topic: "bug",
    tags: ["dashboard", "bug"],
    priority: "normal",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "i have a bar chart broken down by category and the bars visibly sum to more than the Total number shown above the widget. shouldn't they match?" },
      { who: "a", body: "Not necessarily, and this is a subtle one. If the breakdown dimension allows a record to belong to multiple categories (like tags), the per-category bars can double-count while the Total counts each record once, so the bars legitimately exceed the total. Is your breakdown on a tag or multi-value field?" },
      { who: "c", body: "it's on tags, and records can have multiple tags. ok so that's expected, not a bug. good to know." },
      { who: "a", body: "Exactly, expected behavior for multi-value dimensions. If you want the bars to sum to the total, switch the metric to Count of tag-assignments instead of Count of records, or break down by a single-value field. I'll add a tooltip note on our side because you're not the first to ask." }
    ],
    note: "Multi-value (tags) breakdown double-counts vs distinct-record total. Not a bug. Consider UI tooltip.",
    reuse: false
  },
  {
    key: "import-field-mapping-help",
    subject: "CSV columns aren't mapping to the right fields",
    topic: "data",
    tags: ["import", "howto"],
    priority: "normal",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "on import your tool guessed the wrong field for a couple of my columns, it put our internal_id into notes. can i control the mapping?" },
      { who: "a", body: "Yes. On the import screen, the Map columns step lets you override every auto-guessed mapping, click the dropdown next to internal_id and point it at the correct target field (or Create custom field if there's no built-in match). Auto-guess is just a starting point; your overrides win. Want me to look at your file and suggest a mapping?" },
      { who: "c", body: "no i see the dropdowns now, remapped everything correctly. importing again. thanks" }
    ],
    reuse: false
  },
  {
    key: "thanks-great-support",
    subject: "Just wanted to say thanks",
    topic: "feature",
    tags: ["feedback", "praise"],
    priority: "low",
    sentiment: "positive",
    channelPref: "widget",
    turns: [
      { who: "c", body: "not a problem, just wanted to say your support has been genuinely great this month. you fixed our webhook thing fast and the new funnel widget is exactly what we needed. keep it up!" },
      { who: "a", body: "This honestly made our day, thank you so much for taking the time. I'll pass the funnel-widget love to the product team, they'll be thrilled. If you ever want early access to something we're cooking, just say the word. Cheers!" }
    ],
    note: "Happy customer, praised funnel widget + webhook fix. Good candidate for a case study/testimonial ask later.",
    reuse: false
  },
  {
    key: "webhook-delivery-latency",
    subject: "Webhooks arriving several minutes late",
    topic: "performance",
    tags: ["webhooks", "performance"],
    priority: "normal",
    sentiment: "negative",
    turns: [
      { who: "c", body: "our webhooks used to arrive within a second or two, now there's a 3-5 minute lag between the event and delivery. our downstream automation is time-sensitive so this hurts." },
      { who: "a", body: "A creeping delay like that is usually retry backpressure: if your endpoint intermittently returns non-2xx or is slow to respond, those deliveries enter the retry queue and can hold up the ordered stream behind them. Our delivery log shows your endpoint's p95 response time climbed to ~8s recently. Has anything on your side gotten slower, or are you doing heavy work synchronously in the handler?" },
      { who: "c", body: "oh. we added a db write plus an external api call inside the handler recently. that would be the 8s." },
      { who: "a", body: "That's the cause. Best practice: acknowledge the webhook with a fast 2xx immediately, then do the db write and external call asynchronously off a queue. That drops your response time to milliseconds and the lag disappears since nothing sits in retry. Want a short example of that pattern?" }
    ],
    note: "Delivery lag = slow handler (8s p95) causing retry backpressure. Advised fast-ack + async processing.",
    reuse: false
  },
  {
    key: "invoice-download-access",
    subject: "Where do I download past invoices?",
    topic: "billing",
    tags: ["invoice", "billing"],
    priority: "low",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "our accountant needs all our invoices for the year. where do i download them?" },
      { who: "a", body: "Settings > Billing > Invoices lists every invoice with a PDF download on each, and there's a Download all as ZIP button at the top for the full year. If your accountant needs their own read-only login, you can invite them as a Billing viewer so they can self-serve without a full seat. Want steps for that?" },
      { who: "c", body: "the zip is perfect, got them all. thanks" }
    ],
    reuse: true
  },
  {
    key: "telegram-quick-outage-check",
    subject: "is it just me or is search broken",
    topic: "bug",
    tags: ["search", "bug"],
    priority: "normal",
    sentiment: "neutral",
    channelPref: "telegram",
    turns: [
      { who: "c", body: "hey quick one, search across records returns nothing for me right now even for stuff i know exists. is it down?" },
      { who: "a", body: "Not a full outage, but we did have a brief search-indexing hiccup in the last hour that could return empty results for recent queries. It's recovering now. Can you hard-refresh and try a search you know should match? If it's still empty in 5 min tell me the exact term and I'll check the index." },
      { who: "c", body: "refreshed, working again now. false alarm, thanks" }
    ],
    reuse: false
  },
  {
    key: "data-export-api-large-timeout",
    subject: "Export API times out on large accounts",
    topic: "api",
    tags: ["api", "export"],
    priority: "high",
    sentiment: "negative",
    turns: [
      { who: "c", body: "calling POST /v2/exports for our full dataset just times out after 30s. we have millions of rows. is there a better way than the sync endpoint?" },
      { who: "a", body: "Right, the synchronous export isn't meant for datasets that large. Use the async flow instead: POST /v2/exports with async: true returns immediately with an export_id, we process it in the background, and you either poll GET /v2/exports/{id} for status or, better, register a webhook so you get notified when it's ready and hand you a signed download URL. That handles millions of rows without any timeout. Want the doc link?" },
      { who: "c", body: "async + webhook is exactly what we need. yes send the link, and does the download url expire?" },
      { who: "a", body: "Link sent. Yes, the signed download URL expires after 24 hours, just re-request the export or hit the status endpoint again to mint a fresh URL if you need it later. The export file itself is retained for 7 days." }
    ],
    note: "Steered large-account export from sync (30s cap) to async + webhook. URL expires 24h, file kept 7d.",
    reuse: false
  },
  {
    key: "onboarding-connect-data-source",
    subject: "Can't get my first data source to connect",
    topic: "onboarding",
    tags: ["onboarding", "integration"],
    priority: "normal",
    sentiment: "neutral",
    turns: [
      { who: "c", body: "new here. trying to connect our postgres as a data source but the test connection fails with connection refused. our db is definitely up." },
      { who: "a", body: "Connection refused almost always means our IPs aren't allowed through your database's firewall/security group. You'll need to allowlist our egress IP ranges (listed under Settings > Data Sources > Connection info) and make sure the DB is reachable on its port from outside. Are you on a managed DB like RDS, or self-hosted? That changes where the allowlist lives." },
      { who: "c", body: "it's on RDS. i'll add your IPs to the security group. does it need to be a specific user with certain grants?" },
      { who: "a", body: "For RDS, add our IP ranges to the inbound rules of the DB's security group on the Postgres port. And yes, create a dedicated read-only user with SELECT on the schemas you want to sync, don't use a superuser. Once the SG rule is in and you use that user's creds, the test connection will pass. Ping me if it still refuses after the SG change." }
    ],
    note: "RDS connection refused = SG didn't allow our egress IPs. Advised dedicated read-only user.",
    reuse: false
  }
];
