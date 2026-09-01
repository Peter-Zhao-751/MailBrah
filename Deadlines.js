/**
 * Deadlines become Google Tasks, not calendar time blocks: a task shows up on
 * the due date in Calendar's task row, in the Gmail/Tasks sidebar, and on the
 * phone — and it stays visible until checked off, unlike an event that just
 * scrolls into the past.
 *
 * The Tasks API stores only the due DATE (it discards the time), so the exact
 * time lives in the task title: "PHYS 152 — HW 4 — due 11:59 PM".
 * If the Tasks service is unavailable for any reason, falls back to an
 * all-day calendar event with the time in the title.
 */

/**
 * @param {Object} evt {title, start, description, sourceSubject}
 * @return {string} 'task' or 'event' — which form was created
 */
function createDeadlineTask_(evt) {
  var timeStr = Utilities.formatDate(evt.start, CONFIG.TIMEZONE, 'h:mm a');
  var notes = (evt.description ? evt.description + '\n\n' : '') +
    (evt.sourceSubject ? 'From: "' + evt.sourceSubject + '"\n' : '') +
    'Added by MailBrah';
  var created = 'event';
  var artifactRef = '';

  try {
    var task = Tasks.Tasks.insert({
      title: evt.title + ' — due ' + timeStr,
      notes: notes,
      // Date-only (local due date); the API discards any time component.
      due: Utilities.formatDate(evt.start, CONFIG.TIMEZONE, 'yyyy-MM-dd') + 'T00:00:00.000Z'
    }, '@default');
    created = 'task';
    artifactRef = 't:' + task.id;
  } catch (err) {
    Logger.log('Tasks insert failed (%s) — falling back to an all-day event.', err);
    var fallback = getCalendar_().createAllDayEvent(
      evt.title + ' — due ' + timeStr,
      stripTime_(evt.start),
      { description: notes }
    );
    artifactRef = 'c:' + fallback.getId();
  }

  // Record under the ORIGINAL title so future emails about this deadline
  // fingerprint-match regardless of which form was created.
  recordDecision_(eventFingerprint_(evt.title, evt.start), 'added', evt.start, evt.title, artifactRef);
  return created;
}
