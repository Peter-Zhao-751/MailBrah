# MailBrah 📬→📅

A Google Apps Script that watches your Gmail for USC emails, uses the **free**
Gemini API to extract events, and:

- **auto-adds** events you're clearly committed to (classes, appointments,
  RSVPs, exams) — but only when your calendar is free at that time;
- **deadlines become Google Tasks**, not fake calendar time blocks: checkable,
  visible in Calendar/Gmail/the Tasks app, and they stay until you're done.
  Exact due time lives in the task title (Tasks only stores the date);
- **optional Gradescope sync**: every 6 hours it reads your Gradescope courses
  and turns unsubmitted upcoming assignments into tasks too (see below);
- **optional Brightspace sync**: reads your official D2L calendar feed (no
  login or scraping) and turns due dates and quizzes into tasks (see below);
- **asks you** about optional stuff (career fairs, club events, talks) and
  anything that conflicts with an existing calendar event, via a **Gmail
  add-on card** with *Add to calendar* / *Decline* buttons that works on your
  phone;
- **never duplicates**: repeat/reminder emails about the same event are
  detected by fingerprint, by fuzzy title+time match against your live
  calendar, and declined events stay declined.

Everything runs on Google's free infrastructure. The LLM is the Gemini API
free tier (no credit card, no billing account — just an API key from AI
Studio). Nothing here can spend money.

> **Why not Claude Code / Codex as the brain?** Apps Script runs in Google's
> cloud on a 30-minute timer; it cannot reach a CLI running on your laptop
> (no public endpoint, and your laptop would have to be awake 24/7). The
> Gemini free tier is the zero-dollar option that actually works unattended.

---

## Setup (~10 minutes, all free)

### 0. Which Google account?
Install MailBrah on the account where your USC email actually **arrives** —
the script can only search the mailbox it lives in, and the calendar it
writes to belongs to that same account. If USC mail lands in a USC-managed
Workspace account, note that USC's admins may block Apps Script, add-on
test installs, or AI Studio keys there; the reliable free path is a
**personal @gmail.com account with USC mail auto-forwarded to it** (Gmail →
Settings → Forwarding, or a USC mail rule), which also keeps your primary
Google Calendar as the target.

### 1. Get a free Gemini API key
1. Go to <https://aistudio.google.com/apikey> (sign in with the same Google
   account as your Gmail/Calendar).
2. **Create API key**. No credit card is asked for; the free tier is the
   default. Copy the key.

### 2. Create the Apps Script project
1. Go to <https://script.google.com> → **New project**. Name it `MailBrah`.
2. **Project Settings** (gear icon) → check **"Show 'appsscript.json' manifest
   file in editor"**.
3. Back in the editor, replace the contents of `appsscript.json` with this
   repo's `appsscript.json`.
4. Create one script file per `.js` file in this repo (**+ → Script**, name it
   e.g. `Config` — the editor adds `.gs`) and paste the contents:
   `Config`, `Gemini`, `CalendarSync`, `PendingStore`, `Main`, `AddonUI`,
   `Setup`.
5. Save everything (⌘S).

*(Alternative for CLI people: `npm i -g @google/clasp`, `clasp login`,
`clasp create --type standalone --title MailBrah` in this folder, then
`clasp push` — the files here are already clasp-shaped.)*

### 3. Configure and authorize
1. Add your key where secrets belong — **Script Properties** (Apps Script's
   equivalent of an env file; never in code): **Project Settings** (gear
   icon) → **Script Properties** → **Add script property** →
   `GEMINI_API_KEY` = your key. *(Alternative: paste it into `setApiKey()`
   in `Setup.gs`, run once, put the placeholder back.)*
2. Run any function once (e.g. `setup` below) and grant the permissions it
   asks for (Gmail, Calendar, Tasks, external requests — it's your own
   script, the "unverified app" warning is expected: *Advanced → Go to
   MailBrah*).
3. Skim `Config.gs` — especially `USER_PREFERENCES` (what to auto-add vs. ask
   about) and `TIMEZONE`.
4. Run `setup()`. It test-calls Gemini, creates the `mailbrah-processed`
   Gmail label, and installs the every-30-minutes trigger.
5. Optional sanity check: run `dryRunLatest()` to see what Gemini extracts
   from your newest USC email (logs only, writes nothing), then run
   `processInbox()` for a real first scan.

### 4. Install the Gmail add-on (the Accept/Decline card)
1. In the editor: **Deploy → Test deployments → Install** (application type
   *Google Workspace add-on*).
2. **Desktop Gmail**: the MailBrah icon appears in the right-hand side panel —
   click it any time to see pending events.
3. **Phone (Gmail app on Android/iOS)**: open any email and scroll to the
   bottom of the message — the MailBrah add-on chip is there. Tap it to get
   the card with pending events, conflict warnings, and the
   **✔ Add to calendar** / **✖ Decline** buttons.

### 4b. Reply commands (decide by just answering the email)
When a `[MailBrah]` email arrives (the morning digest or a same-day alert),
you can simply **reply in plain words** — no buttons, no links:

> add the career fair, decline the rest

> decline everything. also add dinner with Alex Friday 7pm

Gemini interprets the reply against the pending list on the next scan
(within your trigger interval), acts on it — including creating brand-new
events/deadlines you mention — and answers in the same thread with a
confirmation of exactly what it did.

### 5. How you'll actually use it day-to-day
- Committed events just appear on your calendar (with the source email linked
  in the description).
- When MailBrah is unsure about something, it queues it and tells you by
  email exactly once a day: the **morning digest** (~8:30 AM, after the
  daily USC email flood; silent if nothing is pending) lists everything
  waiting. The only exception is something discovered that's **happening
  today** — that sends an immediate alert. Reply to either in plain words,
  or tap the MailBrah chip at the bottom of the message for buttons; the
  chip on any open email always shows the live queue regardless. (All
  notification emails off: `SEND_DECISION_NOTIFICATIONS: false`; digest
  time: `DIGEST_HOUR`/`DIGEST_MINUTE`.)

---

## Gradescope sync (optional)

Gradescope has no API, no calendar feed, and sends no "assignment posted" or
"due soon" emails — so MailBrah signs in the way your browser does and reads
the assignments tables directly (same approach as every community
Gradescope-to-calendar tool).

1. **If you log in to Gradescope via USC SSO**: set a native password first —
   gradescope.com → "Forgot password?" → your USC email. This is officially
   supported and doesn't touch your USC account.
2. In `Setup.gs`, paste your Gradescope email + password into
   `setGradescopeCredentials()`, run it, then delete them from the file.
3. Run `testGradescope()` — it logs your courses and upcoming unsubmitted
   assignments without creating anything. If it errors, the login failed
   (wrong password, or the SSO step was skipped).
4. Done. Each normal scan (at most every 6 hours — `GS_SCAN_EVERY_HOURS`)
   turns unsubmitted, not-yet-due assignments into `📝 COURSE — HW` tasks.
   Submitted and past-due assignments are skipped automatically.

Heads-up: this is screen-scraping — if Gradescope redesigns those pages it
stops working (harmlessly: you'll see a log line, email processing is
unaffected) until the parser is updated.

## Brightspace sync (optional)

Brightspace (D2L) sits behind USC SSO + Duo, so no password scraping — and
none is needed: D2L publishes an official per-user iCal feed of exactly what
the "Upcoming events" widget shows.

1. In Brightspace, open the **Calendar** tool → **Settings** (gear) → check
   **Enable Calendar Feed** → click **Subscribe** → pick **All Calendars and
   Tasks** → copy the URL (`https://brightspace.usc.edu/d2l/le/calendar/feed/...`).
2. Paste it into `BRIGHTSPACE_ICS_URL` in `Config.gs`.
3. Run `testBrightspace()` — logs how every feed entry would be handled,
   creating nothing.

Feed entries ending in **"- Due"/"- Ends"** and **all-day items** (quizzes)
become tasks (all-day ones due 11:59 PM). Timed entries that look like
**exams/tests** are auto-added as real timed calendar events (conflicts
permitting); other timed entries (sessions, one-offs) go to the
Accept/Decline card so nothing is silently dropped. Only **"- Available"**
entries (content opening, nothing to act on) are ignored. The feed URL
contains a private token — treat it like a password (regenerate it in
Brightspace settings if it leaks).

## How duplicates are prevented

1. **Per-email**: every processed Gmail message ID is remembered; threads get
   the `mailbrah-processed` label, so nothing is analyzed twice.
2. **Per-event**: each event gets a fingerprint (normalized title + start
   minute). Fingerprints of everything added *or declined* are remembered —
   exactly, plus a fuzzy backstop (similar title within ~30 minutes of the
   same start) — so reminder emails for the same event are dropped and
   declining sticks. A *substantially* reworded and rescheduled announcement
   can still slip past and re-ask; worst case is one extra card, since the
   calendar check below still blocks duplicate events.
3. **Against your real calendar**: before adding, MailBrah looks for an
   existing event at an overlapping time with a similar title (word overlap),
   so hand-added events and differently-worded duplicate emails are caught too.
4. **Time corrections**: everything MailBrah adds is remembered with the ID of
   the created event/task. If the same-titled item shows up again on the
   *same day* at a *different time* (a "moved to 5pm" email, a Brightspace or
   Gradescope time change), the existing event is moved / the task is patched
   instead of a duplicate appearing. A change of **day** is the one case not
   auto-handled (same titles recur weekly — "Quiz" — so cross-day matching
   would move the wrong thing): you'll get the new item and should delete the
   old one by hand.

## Free-tier headroom (why this stays $0)

| Resource | Free limit | MailBrah's use |
|---|---|---|
| Gemini API (flash, free tier) | ~10 req/min, on the order of 1,000+/day (see [aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit)) | ≤ 12 per 30-min run, 1 per email — typically well under 100/day |
| Apps Script triggers | 90 min runtime/day | a scan takes seconds |
| UrlFetch calls | 20,000/day | 1 per analyzed email |
| Calendar events created | 5,000/day | a handful |

If you ever hit Gemini rate limits, set `GEMINI_MODEL` to
`gemini-3.5-flash-lite` in `Config.gs` (higher free quota, still plenty smart
for this).

**Privacy note**: on the Gemini *free* tier, Google may use prompts (i.e. the
text of the USC emails sent for analysis) to improve its products. These are
mostly mass announcements, but if that bothers you, tighten `SEARCH_QUERY` to
specific senders, or link a billing account to switch to the paid tier (which
is excluded from training — though then it's no longer $0).

## Troubleshooting

- **Nothing happens**: check **Executions** (left sidebar in the editor) for
  `processInbox` runs and errors.
- **"GEMINI_API_KEY is not set"**: rerun `setApiKey()`.
- **Want to reprocess an email**: remove its `mailbrah-processed` label in
  Gmail, then run `resetAllState()` (clears MailBrah's memory; calendar is
  untouched).
- **Card looks stale on phone**: pull to refresh / reopen the message.
- **Add-on chip missing in the phone's Gmail app**: force-close and reopen the
  Gmail app after installing the test deployment. Google only documents
  mobile visibility for *installed* add-ons; self-installed test deployments
  usually show up too, but it isn't guaranteed. If yours doesn't, you still
  get the notification emails (with the event list in plain text) plus the
  full card on desktop Gmail's side panel. (Private Marketplace publishing is
  *not* a fallback for a personal @gmail.com account — it requires a
  Workspace organization.)
- Note: Google Workspace add-on *homepages* don't exist on mobile — on the
  phone the card is only reachable from the bottom of an open message. That's
  why MailBrah emails you when there's something to decide.
