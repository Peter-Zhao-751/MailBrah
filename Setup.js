/**
 * One-time setup and manual test helpers. Run these from the Apps Script
 * editor (select the function in the toolbar dropdown, press Run).
 *
 * SECRETS never belong in this file (it may end up in a git repo). Apps
 * Script's equivalent of an env file is SCRIPT PROPERTIES — set them in the
 * editor UI: Project Settings (gear icon) > Script Properties > Add:
 *   GEMINI_API_KEY  = your key from https://aistudio.google.com/apikey
 *   GS_EMAIL        = your Gradescope email        (optional)
 *   GS_PASSWORD     = your Gradescope password     (optional)
 * The setter functions below are just a convenience wrapper around the same
 * store: if you use them, paste the value, run once, and IMMEDIATELY revert
 * the placeholder before saving/committing.
 */

/**
 * Convenience alternative to the Script Properties UI for the Gemini key.
 * Paste key -> run once -> put the placeholder back. Prefer the UI.
 */
function setApiKey() {
  var key = 'PASTE_YOUR_GEMINI_API_KEY_HERE';
  if (key.indexOf('PASTE_') === 0) {
    throw new Error('Either edit setApiKey() with your key from aistudio.google.com/apikey, ' +
      'or (better) add it as GEMINI_API_KEY under Project Settings > Script Properties.');
  }
  PropertiesService.getScriptProperties().setProperty(PROPS.API_KEY, key.trim());
  Logger.log('API key saved to Script Properties. Now put the placeholder back in this file.');
}

/**
 * STEP 2 — run once. Verifies the API key with a live Gemini call, creates the
 * Gmail label, and installs the recurring trigger.
 */
function setup() {
  // 1. Verify the Gemini key actually works before anything else.
  var probe = extractEventsWithGemini({
    subject: 'Test: Coffee chat',
    from: 'test@usc.edu',
    receivedIso: Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss"),
    body: 'Join us for a coffee chat tomorrow at 3pm in the Student Union.'
  });
  Logger.log('Gemini OK — test extraction returned %s event(s).', probe.length);

  // 2. Gmail label used to mark processed threads.
  if (!GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL)) {
    GmailApp.createLabel(CONFIG.PROCESSED_LABEL);
  }

  // 3. Recurring triggers (replaces any existing MailBrah triggers):
  //    the scan every few minutes, and the daily morning digest.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'processInbox' || fn === 'sendDailyDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInbox')
    .timeBased()
    .everyMinutes(CONFIG.TRIGGER_EVERY_MINUTES)
    .create();
  ScriptApp.newTrigger('sendDailyDigest')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.DIGEST_HOUR)
    .nearMinute(CONFIG.DIGEST_MINUTE)
    .create();

  Logger.log('Setup complete. processInbox runs every %s minutes; the digest ' +
    'goes out daily around %s:%s. Run processInbox() now for an immediate first scan.',
    CONFIG.TRIGGER_EVERY_MINUTES, CONFIG.DIGEST_HOUR,
    ('0' + CONFIG.DIGEST_MINUTE).slice(-2));
}

/**
 * OPTIONAL — Gradescope deadline sync. Prefer adding GS_EMAIL and GS_PASSWORD
 * under Project Settings > Script Properties; this setter is the code
 * alternative (paste -> run once -> put placeholders back).
 * If you normally log in via USC SSO: first set a native password at
 * gradescope.com > "Forgot password" with your USC email (officially
 * supported; doesn't affect your USC account).
 */
function setGradescopeCredentials() {
  var email = 'PASTE_GRADESCOPE_EMAIL';
  var password = 'PASTE_GRADESCOPE_PASSWORD';
  if (email.indexOf('PASTE_') === 0 || password.indexOf('PASTE_') === 0) {
    throw new Error('Either edit setGradescopeCredentials() with your login, or (better) add ' +
      'GS_EMAIL and GS_PASSWORD under Project Settings > Script Properties.');
  }
  var props = PropertiesService.getScriptProperties();
  props.setProperty(PROPS.GS_EMAIL, email.trim());
  props.setProperty(PROPS.GS_PASSWORD, password);
  props.deleteProperty(PROPS.GS_COOKIES); // force a fresh login next scan
  props.deleteProperty(PROPS.GS_LAST);
  Logger.log('Gradescope credentials saved. Put the placeholders back, then run testGradescope().');
}

/**
 * Dry run for Gradescope: logs in, lists your courses and upcoming
 * unsubmitted assignments. Creates NO tasks — logs only.
 */
function testGradescope() {
  var courses = gsListCourses_();
  Logger.log('Found %s course(s): %s', courses.length,
    courses.map(function (c) { return c.shortName; }).join(', ') || '(none)');
  courses.forEach(function (course) {
    var upcoming = gsListAssignments_(course.id).filter(function (a) {
      return !a.submitted && a.due.getTime() > Date.now();
    });
    upcoming.forEach(function (a) {
      Logger.log('  %s — "%s" due %s', course.shortName, a.title,
        Utilities.formatDate(a.due, CONFIG.TIMEZONE, 'EEE MMM d, h:mm a'));
    });
    if (!upcoming.length) Logger.log('  %s — no upcoming unsubmitted assignments.', course.shortName);
  });
}

/**
 * Dry run for Brightspace: fetches your calendar feed and logs how each entry
 * would be handled (task / event / ask / skipped). Creates NO tasks — logs only.
 * Requires CONFIG.BRIGHTSPACE_ICS_URL to be set in Config.
 */
function testBrightspace() {
  if (!brightspaceConfigured_()) {
    throw new Error('Set BRIGHTSPACE_ICS_URL in Config first (Brightspace > Calendar > Settings > Enable Calendar Feed > Subscribe).');
  }
  var events = bsFetchFeed_();
  Logger.log('Feed has %s entries (TASK=deadline task, EVENT=auto calendar event, ASK=decision card, SKIP=ignored):', events.length);
  events.forEach(function (ev) {
    var cls = bsClassify_(ev);
    var when = Utilities.formatDate(ev.start, CONFIG.TIMEZONE, 'EEE MMM d h:mm a');
    Logger.log('  %s  "%s" (%s%s)', cls.type.toUpperCase(), cls.title || ev.summary, when,
      ev.allDay ? ', all-day' : '');
  });
}

/**
 * Dry run: extract events from your most recent USC email and log the raw
 * LLM output. Touches nothing — no calendar writes, no labels, no state.
 */
function dryRunLatest() {
  var threads = GmailApp.search('from:usc.edu', 0, 1);
  if (!threads.length) {
    Logger.log('No usc.edu email found. Adjust the search in dryRunLatest() to test.');
    return;
  }
  var msgs = threads[0].getMessages();
  var msg = msgs[msgs.length - 1];
  Logger.log('Testing on: "%s" from %s', msg.getSubject(), msg.getFrom());
  var events = extractEventsWithGemini({
    subject: msg.getSubject(),
    from: msg.getFrom(),
    receivedIso: Utilities.formatDate(msg.getDate(), CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss"),
    body: msg.getPlainBody()
  });
  Logger.log(JSON.stringify(events, null, 2));
}

/**
 * One-shot health check: verifies every subsystem and logs a PASS/FAIL
 * report. Read-only — creates nothing, sends nothing.
 */
function runDiagnostics() {
  var props = PropertiesService.getScriptProperties();
  var report = [];
  var add = function (status, label, detail) {
    report.push(status + '  ' + label + (detail ? ' — ' + detail : ''));
  };

  try {
    var probe = callGemini_('Return JSON with an empty events array.', GEMINI_EVENTS_SCHEMA);
    add(probe ? 'PASS' : 'FAIL', 'Gemini API', 'model ' + CONFIG.GEMINI_MODEL);
  } catch (err) { add('FAIL', 'Gemini API', String(err).slice(0, 140)); }

  try {
    add(GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL) ? 'PASS' : 'FAIL',
      'Gmail label "' + CONFIG.PROCESSED_LABEL + '"');
    var waiting = GmailApp.search(CONFIG.SEARCH_QUERY, 0, 1);
    add('PASS', 'Gmail search', waiting.length ? 'unprocessed USC mail is waiting' : 'no unprocessed USC mail right now');
  } catch (err) { add('FAIL', 'Gmail access', String(err).slice(0, 140)); }

  try {
    add('PASS', 'Calendar', '"' + getCalendar_().getName() + '"');
  } catch (err) { add('FAIL', 'Calendar', String(err).slice(0, 140)); }

  try {
    var lists = Tasks.Tasklists.list();
    var n = (lists && lists.items ? lists.items.length : 0);
    add(n ? 'PASS' : 'FAIL', 'Google Tasks service', n + ' task list(s)');
  } catch (err) {
    add('FAIL', 'Google Tasks service',
      String(err).slice(0, 100) + ' (deadlines fall back to all-day events)');
  }

  var handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  add(handlers.indexOf('processInbox') !== -1 ? 'PASS' : 'FAIL', 'Scan trigger', 'every ' + CONFIG.TRIGGER_EVERY_MINUTES + ' min');
  add(handlers.indexOf('sendDailyDigest') !== -1 ? 'PASS' : 'FAIL', 'Digest trigger', '~' + CONFIG.DIGEST_HOUR + ':' + ('0' + CONFIG.DIGEST_MINUTE).slice(-2) + ' daily');

  add('INFO', 'Gradescope', gradescopeConfigured_() ? 'configured' : 'not configured (optional)');
  add('INFO', 'Brightspace', brightspaceConfigured_() ? 'configured' : 'not configured (optional)');

  var lastRun = props.getProperty(PROPS.LAST_RUN);
  add(lastRun ? 'PASS' : 'FAIL', 'Last scan', lastRun
    ? Utilities.formatDate(new Date(Number(lastRun)), CONFIG.TIMEZONE, 'MMM d, h:mm a')
    : 'never — run processInbox()');
  add('INFO', 'Pending decisions', String(listPending_().length));
  add('INFO', 'Remembered decisions', String(Object.keys(getDecided_()).length));
  add('INFO', 'Seen messages', String(getSeenMessageIds_().length));

  Logger.log('\n%s', report.join('\n'));
}

/**
 * End-to-end task test: creates ONE real Google Task due tomorrow 5 PM
 * through the exact production path. Tells you where to look for it.
 * Remove it with clearTestCard() (or just check it off).
 */
function testTaskCreation() {
  var due = new Date();
  due = new Date(due.getFullYear(), due.getMonth(), due.getDate() + 1, 17, 0, 0);
  var created = createDeadlineTask_({
    title: '[MailBrah Test] Task check',
    start: due,
    description: 'Created by testTaskCreation() — clearTestCard() removes it.',
    sourceSubject: 'diagnostics'
  });
  if (created === 'task') {
    Logger.log('Created a real Google TASK due tomorrow 5:00 PM. Where to look:\n' +
      '  1. calendar.google.com — tick the "Tasks" checkbox under My calendars (left sidebar), then look at TOMORROW.\n' +
      '  2. Google Calendar phone app — ☰ menu, make sure Tasks is ticked; check tomorrow.\n' +
      '  3. The Google Tasks app / Gmail right sidebar — shows it in list form immediately.\n' +
      'Clean up with clearTestCard().');
  } else {
    Logger.log('Tasks service unavailable — it fell back to an all-day calendar EVENT tomorrow. ' +
      'Check that appsscript.json has the Tasks advanced service and re-authorize (run any function and accept).');
  }
}

/**
 * Phone test for the Gmail card: seeds three fake pending events (a plain
 * one, one with a conflict warning, and a deadline) and sends the real
 * notification email. On your phone: open that email in the Gmail app,
 * scroll to the bottom, tap the MailBrah icon — the card should show all
 * three with working Accept/Decline buttons. Accepting really creates a
 * calendar event / task (that's part of the test); run clearTestCard()
 * afterward to remove everything this test created.
 */
function seedTestCard() {
  var d = new Date();
  var tomorrow = function (h, m) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m, 0);
  };
  var seeds = [
    {
      title: '[MailBrah Test] Career Fair — Viterbi',
      kind: 'event', start: tomorrow(15, 0), end: tomorrow(17, 0),
      location: 'Trousdale Parkway',
      reasoning: 'Optional event — might interest you.',
      conflicts: []
    },
    {
      title: '[MailBrah Test] Guest Lecture: AI Ethics',
      kind: 'event', start: tomorrow(17, 0), end: tomorrow(18, 0),
      location: 'SGM 101',
      reasoning: 'Would have auto-added, but it conflicts with your calendar.',
      conflicts: ['CSCI 104 Lecture (5:00–5:50 PM)'] // fake conflict, for display
    },
    {
      title: '[MailBrah Test] PHYS 152 HW 0',
      kind: 'deadline', start: tomorrow(23, 59), end: tomorrow(23, 59),
      location: '',
      reasoning: 'Test deadline — Accept turns it into a Google Task.',
      conflicts: []
    }
  ];
  var titles = [];
  seeds.forEach(function (s) {
    var added = addPending_({
      id: eventFingerprint_(s.title, s.start),
      title: s.title,
      kind: s.kind,
      startIso: s.start.toISOString(),
      endIso: new Date(s.end.getTime() + (s.kind === 'deadline' ? 3600000 : 0)).toISOString(),
      allDay: false,
      location: s.location,
      description: 'Seeded by seedTestCard() — safe to accept or decline.',
      reasoning: s.reasoning,
      conflicts: s.conflicts,
      sourceSubject: 'MailBrah card test',
      sourceMsgId: '',
      createdAt: Date.now()
    });
    if (added) titles.push(s.title);
  });
  if (titles.length) sendUrgentNotification_(titles);
  Logger.log('%s test entr%s seeded%s. Phone: open the "[MailBrah]" email in the Gmail app, ' +
    'scroll to the bottom of the message, tap the MailBrah icon. Desktop: MailBrah icon in ' +
    'Gmail\'s right side panel. Clean up with clearTestCard().',
    titles.length, titles.length === 1 ? 'y' : 'ies',
    titles.length ? ' and notification email sent' : ' (already seeded — no email re-sent)');
}

/** Removes everything seedTestCard() created — pending cards, remembered decisions, and any calendar events/tasks made by tapping Accept during the test. */
function clearTestCard() {
  var props = PropertiesService.getScriptProperties();
  var cleared = 0;
  listPending_().forEach(function (p) {
    if (p.title.indexOf('[MailBrah Test]') === 0) {
      takePending_(p.id);
      cleared++;
    }
  });
  var decided = getDecided_();
  Object.keys(decided).forEach(function (fp) {
    var e = decided[fp];
    if (!e.t || e.t.indexOf('mailbrah test') !== 0) return;
    try {
      if (e.a && e.a.indexOf('c:') === 0) {
        var ev = getCalendar_().getEventById(e.a.slice(2));
        if (ev) ev.deleteEvent();
      } else if (e.a && e.a.indexOf('t:') === 0) {
        Tasks.Tasks.remove('@default', e.a.slice(2));
      }
    } catch (err) {
      Logger.log('Could not delete test artifact %s (%s) — remove it by hand if it exists.', e.a, err);
    }
    props.deleteProperty(DECIDED_PREFIX + fp);
    cleared++;
  });
  Logger.log('Cleared %s test entr%s (pending cards, decisions, and created items).',
    cleared, cleared === 1 ? 'y' : 'ies');
}

/**
 * DANGER: wipes MailBrah's memory (seen messages, decisions, pending queue,
 * failure counters). Calendar events and Gmail labels are left alone.
 * Already-labeled threads stay skipped; remove the label in Gmail to
 * reprocess a thread.
 */
function resetAllState() {
  var props = PropertiesService.getScriptProperties();
  var keep = [PROPS.API_KEY, PROPS.GS_EMAIL, PROPS.GS_PASSWORD];
  Object.keys(props.getProperties()).forEach(function (key) {
    if (keep.indexOf(key) === -1) props.deleteProperty(key);
  });
  Logger.log('MailBrah state cleared (API key and Gradescope credentials kept).');
}
