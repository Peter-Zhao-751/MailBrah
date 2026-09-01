/**
 * Calendar creation, duplicate detection, and conflict detection.
 *
 * Duplicate protection is two layers:
 *  1. A "decided" store in Script Properties: fingerprints of every event
 *     already auto-added, accepted, or declined — plus a fuzzy title+time
 *     backstop, so a reworded reminder email for a declined event doesn't
 *     re-ask (the calendar can't help there: nothing was created).
 *  2. A live calendar check: any existing event overlapping the same time
 *     with a similar title counts as a duplicate — catches events you added
 *     by hand or that arrived via a differently-worded email.
 */

function getCalendar_() {
  var cal = CONFIG.CALENDAR_ID === 'primary'
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  if (!cal) throw new Error('Calendar not found: ' + CONFIG.CALENDAR_ID);
  return cal;
}

function normalizeTitle_(title) {
  // Punctuation becomes a space (not deleted) so "Sign-Up" tokenizes the same
  // way here as in titleSimilarity_.
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Stable fingerprint: normalized title + start minute. */
function eventFingerprint_(title, startDate) {
  var startKey = Utilities.formatDate(startDate, CONFIG.TIMEZONE, 'yyyyMMddHHmm');
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5,
    normalizeTitle_(title) + '|' + startKey);
  return digest.map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

/** Parse "YYYY-MM-DDTHH:mm[:ss]" as local wall time in the script timezone. */
function parseLocalIso_(isoLocal) {
  var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(isoLocal || ''));
  if (!m) return null;
  // With the manifest timeZone set, the V8 runtime's local zone matches
  // CONFIG.TIMEZONE, so this Date constructor yields the intended instant.
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

/** Token-overlap similarity in [0,1] for fuzzy title matching. */
function titleSimilarity_(a, b) {
  var tokensOf = function (s) {
    return String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter(function (t) { return t.length > 2; });
  };
  var ta = tokensOf(a), tb = tokensOf(b);
  if (!ta.length || !tb.length) return 0;
  var setB = {};
  tb.forEach(function (t) { setB[t] = true; });
  var overlap = ta.filter(function (t) { return setB[t]; }).length;
  return overlap / Math.min(ta.length, tb.length);
}

/**
 * True if this event already exists — on the calendar (similar title,
 * overlapping time) or in the decided store (already added/declined before,
 * by exact fingerprint or by similar title at nearly the same time).
 */
function isDuplicate_(title, start, end) {
  var decided = getDecided_();
  if (decided[eventFingerprint_(title, start)]) return true;

  var fps = Object.keys(decided);
  for (var k = 0; k < fps.length; k++) {
    var d = decided[fps[k]];
    if (d.t && Math.abs(d.s - start.getTime()) <= 30 * 60 * 1000 &&
        titleSimilarity_(title, d.t) >= 0.6) {
      return true;
    }
  }

  var existing = getCalendar_().getEvents(
    new Date(start.getTime() - 60 * 1000),
    new Date(end.getTime() + 60 * 1000)
  );
  for (var i = 0; i < existing.length; i++) {
    var ev = existing[i];
    var overlaps = ev.getStartTime() < end && ev.getEndTime() > start;
    if (overlaps && titleSimilarity_(title, ev.getTitle()) >= 0.6) return true;
  }
  return false;
}

/**
 * Earliest free gap of the given length on the given day, inside the waking
 * window (DAY_START_HOUR–DAY_END_HOUR) and never in the past. Checks the
 * calendar once and scans in 30-min steps. Falls back to the window start if
 * the day is fully booked (the caller surfaces the conflict).
 */
function findEarliestFreeSlot_(onDate, durationMs) {
  var dayStart = new Date(onDate.getFullYear(), onDate.getMonth(), onDate.getDate(), CONFIG.DAY_START_HOUR, 0, 0);
  var dayEnd = new Date(onDate.getFullYear(), onDate.getMonth(), onDate.getDate(), CONFIG.DAY_END_HOUR, 0, 0);
  var t = new Date(Math.max(dayStart.getTime(), Date.now() + 15 * 60 * 1000));
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + ((30 - t.getMinutes() % 30) % 30)); // round up to :00/:30

  var busy = getCalendar_().getEvents(dayStart, dayEnd)
    .filter(function (ev) { return !ev.isAllDayEvent(); });

  while (t.getTime() + durationMs <= dayEnd.getTime()) {
    var end = new Date(t.getTime() + durationMs);
    var clash = busy.some(function (ev) {
      return ev.getStartTime() < end && ev.getEndTime() > t;
    });
    if (!clash) return t;
    t = new Date(t.getTime() + 30 * 60 * 1000);
  }
  return dayStart;
}

/** Existing non-all-day events overlapping [start, end): [{title, label}] */
function findConflicts_(start, end) {
  return getCalendar_().getEvents(start, end)
    .filter(function (ev) { return !ev.isAllDayEvent(); })
    .filter(function (ev) { return ev.getStartTime() < end && ev.getEndTime() > start; })
    .map(function (ev) {
      return {
        title: ev.getTitle(),
        label: ev.getTitle() + ' (' + formatTimeRange_(ev.getStartTime(), ev.getEndTime()) + ')'
      };
    });
}

/**
 * Create the calendar event and record its fingerprint as decided.
 * For all-day events, evt.end is the EXCLUSIVE end (00:00 the day after the
 * last day), matching CalendarApp's multi-day overload.
 * @param {Object} evt {title, start, end, allDay, location, description, sourceSubject, sourceMsgId}
 */
function createCalendarEvent_(evt) {
  var cal = getCalendar_();
  var description = (evt.description ? evt.description + '\n\n' : '') +
    'From email: "' + (evt.sourceSubject || '') + '"\n' +
    (evt.sourceMsgId ? 'https://mail.google.com/mail/u/0/#all/' + evt.sourceMsgId + '\n' : '') +
    'Added by MailBrah';
  var options = { description: description };
  if (evt.location) options.location = evt.location;

  var created;
  if (evt.allDay) {
    var startDay = stripTime_(evt.start);
    var endDayExclusive = stripTime_(evt.end);
    created = (endDayExclusive.getTime() - startDay.getTime() > 24 * 3600 * 1000)
      ? cal.createAllDayEvent(evt.title, startDay, endDayExclusive, options)
      : cal.createAllDayEvent(evt.title, startDay, options);
  } else {
    created = cal.createEvent(evt.title, evt.start, evt.end, options);
  }

  recordDecision_(eventFingerprint_(evt.title, evt.start), 'added', evt.start, evt.title,
    'c:' + created.getId());
  return created;
}

function stripTime_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatTimeRange_(start, end) {
  var fmt = function (d, pattern) { return Utilities.formatDate(d, CONFIG.TIMEZONE, pattern); };
  var sameDay = fmt(start, 'yyyyMMdd') === fmt(end, 'yyyyMMdd');
  return sameDay
    ? fmt(start, 'h:mm a') + '–' + fmt(end, 'h:mm a')
    : fmt(start, 'MMM d h:mm a') + ' – ' + fmt(end, 'MMM d h:mm a');
}

function formatEventWhen_(start, end, allDay) {
  var fmt = function (d, pattern) { return Utilities.formatDate(d, CONFIG.TIMEZONE, pattern); };
  if (allDay) {
    // Calendar-date arithmetic (not -24h) so DST transitions can't shift the day.
    var lastDay = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
    return fmt(start, 'yyyyMMdd') === fmt(lastDay, 'yyyyMMdd')
      ? fmt(start, 'EEE, MMM d') + ' (all day)'
      : fmt(start, 'MMM d') + ' – ' + fmt(lastDay, 'MMM d') + ' (all day)';
  }
  return fmt(start, 'EEE, MMM d') + ' · ' + formatTimeRange_(start, end);
}

// ---- Decided store: one property per fingerprint ('MB_D_<fp>' -> {d, s, t}) ----
// Sharded so each write is a single atomic setProperty: a Decline tapped on the
// card while the trigger is mid-run can never be clobbered by a stale bulk write.

var DECIDED_PREFIX = 'MB_D_';
var DECIDED_MAX = 400;

function getDecided_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var map = {};
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(DECIDED_PREFIX) !== 0) return;
    try {
      map[key.slice(DECIDED_PREFIX.length)] = JSON.parse(all[key]);
    } catch (err) { /* corrupt entry — ignored; pruning removes it */ }
  });
  return map;
}

/**
 * @param {string} fingerprint
 * @param {string} decision 'added'|'declined'
 * @param {Date} startDate
 * @param {string} title used for the fuzzy reworded-reminder backstop
 * @param {string=} artifactRef what was created: 'c:<calendarEventId>' or
 *   't:<taskId>' — lets a later time-correction move the item instead of
 *   duplicating it
 */
function recordDecision_(fingerprint, decision, startDate, title, artifactRef) {
  var entry = { d: decision, s: startDate.getTime(), t: normalizeTitle_(title || '').slice(0, 80) };
  if (artifactRef) entry.a = artifactRef;
  PropertiesService.getScriptProperties().setProperty(
    DECIDED_PREFIX + fingerprint, JSON.stringify(entry));
}

/**
 * Time-correction handler: if an item with the SAME normalized title was
 * already added on the SAME local day at a different time (a "corrected
 * hours" email, a Brightspace/Gradescope time change), MOVE the existing
 * calendar event / patch the existing task instead of creating a duplicate.
 *
 * Matching is same-day only on purpose: recurring items share titles
 * ("Quiz" every week) and a wider match would drag last week's item to this
 * week. A change of DAY therefore creates a fresh item — the old one has to
 * be removed by hand (it's logged).
 *
 * @return {boolean} true if this occurrence was handled (moved, or the old
 *   item was deleted by the user and the change was just recorded)
 */
function tryReschedule_(title, start, end) {
  var norm = normalizeTitle_(title).slice(0, 80);
  if (!norm) return false;
  var decided = getDecided_();
  var fps = Object.keys(decided);
  for (var i = 0; i < fps.length; i++) {
    var entry = decided[fps[i]];
    if (entry.d !== 'added' || !entry.a || entry.t !== norm) continue;
    if (Math.abs(entry.s - start.getTime()) < 60 * 1000) return false; // same time: a plain duplicate
    var sameDay = Utilities.formatDate(new Date(entry.s), CONFIG.TIMEZONE, 'yyyyMMdd') ===
      Utilities.formatDate(start, CONFIG.TIMEZONE, 'yyyyMMdd');
    if (!sameDay) continue;

    var moved = false;
    try {
      if (entry.a.indexOf('c:') === 0) {
        var ev = getCalendar_().getEventById(entry.a.slice(2));
        if (ev && !ev.isAllDayEvent()) {
          ev.setTime(start, end);
          moved = true;
        }
      } else if (entry.a.indexOf('t:') === 0) {
        Tasks.Tasks.patch({
          title: title + ' — due ' + Utilities.formatDate(start, CONFIG.TIMEZONE, 'h:mm a'),
          due: Utilities.formatDate(start, CONFIG.TIMEZONE, 'yyyy-MM-dd') + 'T00:00:00.000Z'
        }, '@default', entry.a.slice(2));
        moved = true;
      }
    } catch (err) {
      Logger.log('Time change for "%s" noted, but the old item could not be moved (%s) — it may have been deleted; not recreating.', title, err);
    }
    // Re-point the decided store at the new time either way, so repeat
    // announcements of the corrected time are recognized as duplicates.
    PropertiesService.getScriptProperties().deleteProperty(DECIDED_PREFIX + fps[i]);
    recordDecision_(eventFingerprint_(title, start), 'added', start, title, moved ? entry.a : '');
    if (moved) Logger.log('Time updated: "%s" moved to %s.', title,
      Utilities.formatDate(start, CONFIG.TIMEZONE, 'MMM d h:mm a'));
    return true;
  }
  return false;
}

/**
 * Called from the locked trigger run. Drops entries 2 days after their event
 * started; if over the cap, keeps the SOONEST-starting entries — those are the
 * ones reminder emails are still arriving for (far-future ones can be re-asked).
 */
function pruneDecided_() {
  var props = PropertiesService.getScriptProperties();
  var cutoff = Date.now() - 2 * 24 * 3600 * 1000;
  var live = [];
  var all = props.getProperties();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(DECIDED_PREFIX) !== 0) return;
    var v = null;
    try { v = JSON.parse(all[key]); } catch (err) { /* fall through: delete */ }
    if (!v || !(v.s > cutoff)) props.deleteProperty(key);
    else live.push({ key: key, s: v.s });
  });
  if (live.length > DECIDED_MAX) {
    live.sort(function (a, b) { return a.s - b.s; });
    live.slice(DECIDED_MAX).forEach(function (e) { props.deleteProperty(e.key); });
  }
}
