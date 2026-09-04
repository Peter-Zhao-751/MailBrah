/**
 * MailBrah configuration. Everything user-tunable lives here.
 *
 * The Gemini API key is NOT stored here — set it once via Script Properties:
 *   Project Settings (gear icon) > Script Properties > add GEMINI_API_KEY
 * or run setApiKey() in Setup.js.
 */
var CONFIG = {
  // Gmail search for candidate emails. `from:usc.edu` also matches subdomains
  // like @email.usc.edu and @announce.usc.edu. `-subject:mailbrah` keeps
  // MailBrah's own notification emails out of the pipeline.
  SEARCH_QUERY: 'from:usc.edu -subject:mailbrah newer_than:3d -label:mailbrah-processed',

  // Label applied to threads after processing (also referenced in SEARCH_QUERY).
  PROCESSED_LABEL: 'mailbrah-processed',

  // 'primary' uses your default calendar; otherwise a calendar ID like
  // 'xxxx@group.calendar.google.com'.
  CALENDAR_ID: 'primary',

  // Used for parsing LLM-returned local times and formatting card text.
  // Keep in sync with "timeZone" in appsscript.json.
  TIMEZONE: 'America/Los_Angeles',

  // Gemini model to use. Free-tier models (no billing needed) as of Aug 2026:
  // 'gemini-3.7-flash' (default), 'gemini-3.5-flash', 'gemini-3.5-flash-lite'
  // (higher free quota). Check limits at https://aistudio.google.com/rate-limit
  GEMINI_MODEL: 'gemini-3.7-flash',

  // Tried in order when the model above is overloaded (HTTP 503) or
  // rate-limited (HTTP 429) — the newest model sheds free-tier load first.
  GEMINI_FALLBACK_MODELS: ['gemini-3.5-flash', 'gemini-3.5-flash-lite'],

  // Safety caps per trigger run, to stay far inside free quotas.
  MAX_THREADS_PER_RUN: 10,
  MAX_LLM_CALLS_PER_RUN: 12,

  // Cheap pre-filter: an email is only sent to Gemini if subject+body match
  // at least one of these patterns (case-insensitive regex). Anything with no
  // time/date/event signal at all is skipped for free. False positives are
  // harmless (one AI call); keep patterns generous to avoid missing events.
  PREFILTER_ENABLED: true,
  PREFILTER_PATTERNS: [
    '\\d\\s*(a\\.?m\\.?|p\\.?m\\.?)\\b',                  // 3pm, 10 a.m.
    '\\b\\d{1,2}:\\d{2}\\b',                              // 9:00, 14:30
    '\\b(noon|midnight)\\b',
    '\\b(mon|tues?|wed(nes)?|thurs?|fri|sat(ur)?|sun)(day)?\\b',
    '\\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\\b',
    '\\b\\d{1,2}/\\d{1,2}\\b',                            // 9/5, 10/12
    '\\b\\d{4}-\\d{2}-\\d{2}\\b',                         // 2026-09-05
    '\\b\\d{1,2}(st|nd|rd|th)\\b',                        // 5th, 21st
    '\\b(today|tomorrow|tonight|this week|next week|upcoming)\\b',
    '\\b(deadline|due|rsvp|register|registration|event|meeting|session|workshop|seminar|webinar|fair|exam|midterm|finals?|quiz|schedule|appointment|calendar|save the date|join us)\\b'
  ],

  // Events starting further out than this are skipped as likely
  // mis-extractions (wrong-year dates and similar).
  MAX_EVENT_HORIZON_DAYS: 370,

  // Your waking window. When a reply command gives no clock time ("get
  // altoids tomorrow"), the event is slotted into the EARLIEST free gap on
  // your calendar inside this window — never before you're up.
  DAY_START_HOUR: 9,
  DAY_END_HOUR: 22,

  // Master switch for notification emails. When true you get:
  //  - ONE morning digest (below) every day, listing everything awaiting a
  //    decision (or confirming nothing is), and
  //  - an immediate email only when a newly found item happens TODAY.
  // REPLYING to either in plain words ("add the career fair, decline the
  // rest") is a command — Gemini interprets it and acts on the next scan.
  SEND_DECISION_NOTIFICATIONS: true,

  // When the daily digest goes out (script timezone). nearMinute means
  // Google fires it within ±15 min of DIGEST_HOUR:DIGEST_MINUTE.
  DIGEST_HOUR: 8,
  DIGEST_MINUTE: 30,

  // Max reply-command messages interpreted per scan (1 Gemini call each).
  MAX_REPLY_COMMANDS_PER_RUN: 5,

  // An undecided item is dropped after this long in the queue (and always
  // once its event has passed) — keeps the card and emails concise. If a
  // fresh email about the same event arrives later, it gets asked anew.
  PENDING_MAX_AGE_HOURS: 48,

  // Trigger frequency in minutes (used by setup()). Valid: 1, 5, 10, 15, 30.
  // 5 is the sweet spot: near-realtime replies/emails at ~20% of the free
  // tier's 90-min/day trigger-runtime quota. Every-1-minute would spend most
  // of that quota on idle runs and risk dead runs late in the day.
  TRIGGER_EVERY_MINUTES: 5,

  // Gradescope deadline sync (active once setGradescopeCredentials() is run).
  // Kept at hours, not minutes, on purpose: this is screen-scraping a login-
  // protected site — hammering it risks rate limiting or bot protection
  // flagging your account. Assignments post a few times a week anyway.
  GS_SCAN_EVERY_HOURS: 3,
  GS_MAX_COURSES: 8,

  // Brightspace (D2L) deadline sync. Paste your personal calendar-feed URL:
  // Brightspace > Calendar > Settings (gear) > Enable Calendar Feed >
  // Subscribe > All Calendars and Tasks > copy URL. Leave '' to disable.
  // A single cheap fetch of an official feed — hourly is fine.
  BRIGHTSPACE_ICS_URL: '',
  BS_SCAN_EVERY_HOURS: 1,

  // Free-form guidance injected into the LLM prompt. Edit to taste — this is
  // where "intelligently" gets personalized.
  USER_PREFERENCES: [
    'I am a USC student.',
    'AUTO-ADD (decision "auto_add"): things I am personally committed to —',
    'my registered classes and schedule changes, advising or medical',
    'appointments, events I already RSVP\'d to, exams, and hard academic',
    'deadlines (add deadlines as events at the due time).',
    'ASK ME (decision "ask_user"): optional-but-plausibly-interesting things —',
    'career fairs, info sessions, club meetings, guest speakers, workshops,',
    'social events, free food events.',
    'IGNORE (decision "ignore"): pure marketing, fundraising asks, surveys,',
    'newsletters with no single concrete event, and events that already',
    'happened.'
  ].join(' ')
};

/**
 * Script Properties keys (internal). Two more families of keys exist as one
 * property per entry: 'MB_P_<id>' (pending decisions, PendingStore.js) and
 * 'MB_D_<fingerprint>' (added/declined decisions, CalendarSync.js).
 */
var PROPS = {
  API_KEY: 'GEMINI_API_KEY',
  SEEN_MESSAGES: 'MB_SEEN_MSGS',   // JSON array of processed Gmail message IDs
  FAILS: 'MB_FAILS',               // JSON map messageId -> consecutive failure count
  LAST_RUN: 'MB_LAST_RUN',         // epoch ms of last successful scan
  ABORT: 'MB_ABORT',               // set by a new run to ask an in-flight run to stop
  GS_EMAIL: 'GS_EMAIL',            // Gradescope login (set via setGradescopeCredentials)
  GS_PASSWORD: 'GS_PASSWORD',
  GS_COOKIES: 'MB_GS_COOKIES',     // cached Gradescope session cookies
  GS_LAST: 'MB_GS_LAST',           // epoch ms of last Gradescope scan
  BS_LAST: 'MB_BS_LAST',           // epoch ms of last Brightspace feed scan
  PRUNE_LAST: 'MB_PRUNE_LAST'      // epoch ms of last decided-store pruning
};
