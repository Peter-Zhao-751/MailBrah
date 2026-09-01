/**
 * Store for "not sure — you decide" events awaiting Accept/Decline in the
 * Gmail add-on card. Backed by Script Properties (single-user script).
 *
 * Each pending event is its own property key ('MB_P_<id>') because Script
 * Properties cap values at ~9KB — one big JSON blob would eventually overflow.
 *
 * Pending entry shape:
 *   { id, title, startIso, endIso, allDay, location, description, reasoning,
 *     conflicts: [labels], sourceSubject, sourceMsgId, createdAt }
 */

var PENDING_PREFIX = 'MB_P_';
var PENDING_MAX = 40;

/**
 * Pending events sorted by start time. Every read prunes first — so the
 * card, the emails, and reply commands always see a fresh, concise list:
 * entries whose event has passed are dropped, and entries older than
 * PENDING_MAX_AGE_HOURS expire undecided (a fresh email about the same
 * event can re-raise them later).
 */
function listPending_() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var now = Date.now();
  var maxAgeMs = (CONFIG.PENDING_MAX_AGE_HOURS || 48) * 3600 * 1000;
  var items = [];
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(PENDING_PREFIX) !== 0) return;
    var p;
    try {
      p = JSON.parse(all[key]);
    } catch (err) {
      props.deleteProperty(key);
      return;
    }
    if (new Date(p.endIso).getTime() < now) {
      props.deleteProperty(key); // event is over; the decision is moot
    } else if (p.createdAt && now - p.createdAt > maxAgeMs) {
      Logger.log('Pending item expired undecided after %s h: "%s"',
        CONFIG.PENDING_MAX_AGE_HOURS, p.title);
      props.deleteProperty(key);
    } else {
      items.push(p);
    }
  });
  items.sort(function (a, b) { return new Date(a.startIso) - new Date(b.startIso); });
  return items;
}

/**
 * Add a pending decision. Returns true if added, false if this event is
 * already pending (same fingerprint id) — that's the duplicate-email case.
 */
function addPending_(entry) {
  var props = PropertiesService.getScriptProperties();
  var key = PENDING_PREFIX + entry.id;
  if (props.getProperty(key)) return false;

  // Keep each value small and the store bounded.
  var slim = {
    id: entry.id,
    title: clip_(entry.title, 120),
    kind: entry.kind || 'event',
    startIso: entry.startIso,
    endIso: entry.endIso,
    allDay: !!entry.allDay,
    location: clip_(entry.location, 120),
    description: clip_(entry.description, 300),
    reasoning: clip_(entry.reasoning, 200),
    conflicts: (entry.conflicts || []).slice(0, 3).map(function (c) { return clip_(c, 100); }),
    sourceSubject: clip_(entry.sourceSubject, 120),
    sourceMsgId: entry.sourceMsgId,
    createdAt: entry.createdAt
  };
  props.setProperty(key, JSON.stringify(slim));

  // Over the cap? Drop the furthest-out events (they'll usually be announced
  // again closer to the date). The entry just added may itself be evicted —
  // the return value reflects whether it survived.
  var pending = listPending_();
  if (pending.length > PENDING_MAX) {
    pending.slice(PENDING_MAX).forEach(function (p) {
      Logger.log('Pending queue full — dropping "%s" (%s).', p.title, p.startIso);
      props.deleteProperty(PENDING_PREFIX + p.id);
    });
  }
  return props.getProperty(key) !== null;
}

/** Put an entry back (used when acting on an accepted event fails midway). */
function restorePending_(entry) {
  PropertiesService.getScriptProperties()
    .setProperty(PENDING_PREFIX + entry.id, JSON.stringify(entry));
}

/** Remove one pending entry; returns it (or null if already gone). */
function takePending_(id) {
  var props = PropertiesService.getScriptProperties();
  var key = PENDING_PREFIX + id;
  var raw = props.getProperty(key);
  if (!raw) return null;
  props.deleteProperty(key);
  return JSON.parse(raw);
}

function clip_(s, max) {
  s = String(s || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
