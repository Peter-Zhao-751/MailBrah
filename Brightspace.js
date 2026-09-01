/**
 * Brightspace (D2L) deadline sync — no scraping needed: D2L publishes an
 * official per-user iCal feed (Calendar tool > Settings > Enable Calendar
 * Feed > Subscribe > All Calendars and Tasks). Paste that URL into
 * CONFIG.BRIGHTSPACE_ICS_URL. The token in the URL authenticates it; no
 * password is stored and no SSO/Duo login is involved.
 *
 * Classification of feed entries (matches the "Upcoming events" widget):
 *   "X - Due" / "X - Ends" / "Availability Ends"  -> task (deadline)
 *   all-day entries (e.g. "Quiz")                  -> task due 11:59 PM that day
 *   "X - Available" / "Availability Starts"       -> skipped (content opening,
 *                                                    not something to act on)
 *   timed exam-like entries (exam/midterm/test…)  -> real timed calendar event
 *   other timed entries (sessions, one-offs)      -> the Accept/Decline card
 */

function brightspaceConfigured_() {
  return !!CONFIG.BRIGHTSPACE_ICS_URL;
}

/** @param {Object} stats the run's stats object (adds task titles to .added) */
function processBrightspace_(stats) {
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty(PROPS.BS_LAST) || 0);
  if (Date.now() - last < CONFIG.BS_SCAN_EVERY_HOURS * 3600 * 1000) return;

  var events = bsFetchFeed_();
  Logger.log('Brightspace: %s feed entries.', events.length);
  var now = Date.now();
  var horizon = now + CONFIG.MAX_EVENT_HORIZON_DAYS * 24 * 3600 * 1000;

  events.forEach(function (ev) {
    var cls = bsClassify_(ev);
    if (cls.type === 'skip') return;

    if (cls.type === 'task') {
      var due = ev.allDay
        ? new Date(ev.start.getFullYear(), ev.start.getMonth(), ev.start.getDate(), 23, 59, 0)
        : ev.start;
      if (due.getTime() < now || due.getTime() > horizon) return;
      var dueEnd = new Date(due.getTime() + 60 * 60 * 1000);
      if (tryReschedule_(cls.title, due, dueEnd)) {
        stats.updated.push(cls.title);
        return;
      }
      if (isDuplicate_(cls.title, due, dueEnd)) return;
      createDeadlineTask_({
        title: cls.title,
        start: due,
        description: 'Brightspace: ' + ev.summary,
        sourceSubject: 'Brightspace calendar feed'
      });
      stats.added.push(cls.title);
      Logger.log('Brightspace: task added — %s (due %s)', cls.title,
        Utilities.formatDate(due, CONFIG.TIMEZONE, 'MMM d h:mm a'));
      return;
    }

    // Timed entry: 'event' (exam-like -> auto) or 'ask' (you decide).
    var start = ev.start;
    var end = (ev.end && ev.end > start) ? ev.end : new Date(start.getTime() + 60 * 60 * 1000);
    if (end.getTime() < now || start.getTime() > horizon) return;
    if (tryReschedule_(cls.title, start, end)) {
      stats.updated.push(cls.title);
      return;
    }
    if (isDuplicate_(cls.title, start, end)) return;

    var conflicts = findConflicts_(start, end);
    if (cls.type === 'event' && conflicts.length === 0) {
      createCalendarEvent_({
        title: cls.title, start: start, end: end, allDay: false,
        location: ev.location || '', description: 'From your Brightspace calendar: ' + ev.summary,
        sourceSubject: 'Brightspace calendar feed', sourceMsgId: ''
      });
      stats.added.push(cls.title);
      Logger.log('Brightspace: event added — %s', cls.title);
      return;
    }
    var added = addPending_({
      id: eventFingerprint_(cls.title, start),
      title: cls.title,
      kind: 'event',
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      allDay: false,
      location: ev.location || '',
      description: 'From your Brightspace calendar: ' + ev.summary,
      reasoning: conflicts.length
        ? 'Would have added, but it conflicts with your calendar.'
        : 'Brightspace calendar entry — looks like a session or one-off event; you decide.',
      conflicts: conflicts.map(function (c) { return c.label; }),
      sourceSubject: 'Brightspace calendar feed',
      sourceMsgId: '',
      createdAt: Date.now()
    });
    if (added) {
      stats.pendingNew.push({
        title: cls.title,
        startsToday: Utilities.formatDate(start, CONFIG.TIMEZONE, 'yyyyMMdd') ===
          Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMdd')
      });
    }
  });

  props.setProperty(PROPS.BS_LAST, String(Date.now()));
}

function bsFetchFeed_() {
  var response = UrlFetchApp.fetch(CONFIG.BRIGHTSPACE_ICS_URL, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error('Brightspace feed returned HTTP ' + response.getResponseCode() +
      ' — re-copy the feed URL from Brightspace Calendar > Settings.');
  }
  return bsParseIcs_(response.getContentText());
}

/**
 * Decide what a feed entry is. Returns {type: 'skip'|'task'|'event'|'ask', title}.
 * 'task' = deadline; 'event' = exam-like, auto-added as a timed event;
 * 'ask' = timed non-deadline, routed to the Accept/Decline card.
 * Course code (e.g. MATH-229) is pulled from the entry text when present.
 */
function bsClassify_(ev) {
  var summary = ev.summary;
  if (/availability starts|-\s*available\b|\bopens\b/i.test(summary)) return { type: 'skip' };

  var deadline = /^(.*?)\s*-\s*(due|closes|ends|availability ends)\s*$/i.exec(summary);
  var title = (deadline ? deadline[1] : summary).trim();
  if (!title) return { type: 'skip' };

  var course = /\b([A-Z]{2,5}-\d{3}[A-Z]?)\b/.exec(summary + ' ' + ev.description + ' ' + ev.location);
  if (course && title.indexOf(course[1]) === -1) title = course[1] + ' — ' + title;

  if (deadline || ev.allDay) return { type: 'task', title: title };
  if (/\b(exam|midterm|final|test|quiz|presentation|review session)\b/i.test(summary)) {
    return { type: 'event', title: title };
  }
  return { type: 'ask', title: title };
}

// ---- Minimal iCal parsing (line unfolding, SUMMARY/DESCRIPTION/DTSTART) ----

function bsParseIcs_(ics) {
  var unfolded = String(ics).replace(/\r?\n[ \t]/g, '');
  var events = [];
  unfolded.split('BEGIN:VEVENT').slice(1).forEach(function (chunk) {
    chunk = chunk.split('END:VEVENT')[0];
    var summary = bsIcsField_(chunk, 'SUMMARY');
    var dt = bsIcsDate_(chunk, 'DTSTART');
    if (!summary || !dt) return;
    var endDt = bsIcsDate_(chunk, 'DTEND');
    events.push({
      summary: summary,
      start: dt.date,
      end: endDt && !endDt.allDay ? endDt.date : null,
      allDay: dt.allDay,
      description: bsIcsField_(chunk, 'DESCRIPTION'),
      location: bsIcsField_(chunk, 'LOCATION')
    });
  });
  return events;
}

function bsIcsField_(chunk, name) {
  var m = new RegExp('^' + name + '[^:\\r\\n]*:(.*)$', 'm').exec(chunk);
  if (!m) return '';
  return m[1]
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/** Handles DTSTART:...Z (UTC), DTSTART;TZID=...  (wall time), DTSTART;VALUE=DATE (all-day). */
function bsIcsDate_(chunk, name) {
  var m = new RegExp('^' + name + '([^:\\r\\n]*):([0-9TZ]+)\\s*$', 'm').exec(chunk);
  if (!m) return null;
  var params = m[1], val = m[2];
  if (/VALUE=DATE/i.test(params) || /^\d{8}$/.test(val)) {
    return {
      date: new Date(Number(val.slice(0, 4)), Number(val.slice(4, 6)) - 1, Number(val.slice(6, 8))),
      allDay: true
    };
  }
  var dm = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(val);
  if (!dm) return null;
  if (dm[7] === 'Z') {
    return {
      date: new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +dm[4], +dm[5], +dm[6])),
      allDay: false
    };
  }
  // TZID/floating: treat as local wall time (the script timezone = campus timezone).
  return { date: new Date(+dm[1], +dm[2] - 1, +dm[3], +dm[4], +dm[5], +dm[6]), allDay: false };
}
