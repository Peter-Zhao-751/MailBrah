/**
 * Reply commands: answer a "[MailBrah] ... need your decision" email in plain
 * words and MailBrah acts on it during the next scan.
 *
 *   "add the career fair, decline the rest"
 *   "decline everything"
 *   "add the first two. also add dinner with Alex Friday 7pm"
 *
 * Decisions apply to pending items (same shared logic as the card's buttons);
 * anything else the reply asks to add is created directly. MailBrah answers
 * in-thread with a confirmation of what it did.
 *
 * Loop safety: MailBrah's own messages all start with "MailBrah" and are
 * skipped; every processed message id goes into the seen cache.
 */

function processReplies_(stats) {
  var threads = GmailApp.search('subject:mailbrah newer_than:3d', 0, 10);
  var seenIds = getSeenMessageIds_();
  // Threads with no message newer than the previous run were fully handled
  // already — skip them without fetching their messages (keeps idle runs
  // cheap at a 5-minute cadence). 15-min slack covers run overlap.
  var watermark = Number(PropertiesService.getScriptProperties()
    .getProperty(PROPS.LAST_RUN) || 0) - 15 * 60 * 1000;
  var handled = 0;

  for (var t = 0; t < threads.length; t++) {
    if (threads[t].getLastMessageDate().getTime() < watermark) continue;
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      if (seenIds.indexOf(msg.getId()) !== -1) continue;

      var text = extractReplyText_(msg.getPlainBody());
      if (!text || text.indexOf('MailBrah') === 0) {
        // Our own notification/confirmation — just remember it.
        seenIds.push(msg.getId());
        saveSeenMessageIds_(seenIds);
        continue;
      }
      if (handled >= CONFIG.MAX_REPLY_COMMANDS_PER_RUN) continue; // NOT marked seen: retried next run

      handled++;
      try {
        handleReplyCommand_(msg, text, stats);
      } catch (err) {
        stats.errors++;
        Logger.log('Reply command failed ("%s…"): %s', text.slice(0, 60), err);
      } finally {
        // One attempt per command: marked seen even on failure so a broken
        // reply can't loop forever; no confirmation email = it didn't work.
        seenIds.push(msg.getId());
        saveSeenMessageIds_(seenIds);
      }
    }
  }
  if (handled) Logger.log('Processed %s reply command(s).', handled);
}

function handleReplyCommand_(msg, text, stats) {
  Logger.log('Reply command: "%s"', text.slice(0, 200));
  var pending = listPending_();
  var result = interpretReplyWithGemini_(text, pending);
  var lines = [];

  if (!result) {
    lines.push('Sorry — I couldn\'t interpret that. Try e.g. "add the career fair, decline the rest".');
  } else {
    (result.decisions || []).forEach(function (d) {
      var r = decidePending_(d.id, !!d.accept);
      lines.push(r.message);
      if (r.ok && d.accept) stats.added.push('(reply) accepted');
    });
    (result.newEvents || []).forEach(function (evt) {
      lines.push(executeCommandedEvent_(evt, msg, stats));
    });
    if (!lines.length) {
      lines.push(result.note || 'Nothing actionable found in your reply.');
    } else if (result.note && /couldn|unclear|ambigu|not match|unsure/i.test(result.note)) {
      lines.push(result.note);
    }
  }

  var body = 'MailBrah\n\n' +
    lines.map(function (l) { return '- ' + l; }).join('\n') +
    '\n\nStill pending: ' + listPending_().length;
  try {
    var confirmation = msg.reply(body);
    // Never re-read our own confirmation as a command.
    if (confirmation && confirmation.getId) {
      var ids = getSeenMessageIds_();
      ids.push(confirmation.getId());
      saveSeenMessageIds_(ids);
    }
  } catch (err) {
    Logger.log('Could not send confirmation reply: %s', err);
  }
}

/** The user explicitly asked for this — create it (dup check still applies). */
function executeCommandedEvent_(evt, msg, stats) {
  var title = evt.title || 'Untitled';
  var start = parseLocalIso_(evt.startLocal);
  if (!start) return 'Couldn\'t work out a date for "' + title + '" — try including an explicit date/time.';
  var end = parseLocalIso_(evt.endLocal);
  var isDeadline = evt.kind === 'deadline';

  if (evt.allDay) {
    start = stripTime_(start);
    end = (end && stripTime_(end) > start)
      ? stripTime_(end)
      : new Date(start.getTime() + 24 * 60 * 60 * 1000);
  } else if (!evt.timeGiven) {
    // No clock time stated: deadlines default to end of day; events get the
    // earliest free slot in the waking window ("just make it smart").
    if (isDeadline) {
      start = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 0);
      end = new Date(start.getTime() + 60 * 60 * 1000);
    } else {
      var duration = (end && end > start) ? Math.min(end - start, 4 * 3600 * 1000) : 3600 * 1000;
      start = findEarliestFreeSlot_(start, duration);
      end = new Date(start.getTime() + duration);
    }
  } else if (!end || end <= start) {
    end = new Date(start.getTime() + 60 * 60 * 1000);
  }

  var whenStr = evt.allDay
    ? Utilities.formatDate(start, CONFIG.TIMEZONE, 'EEE, MMM d')
    : Utilities.formatDate(start, CONFIG.TIMEZONE, 'EEE, MMM d · h:mm a');

  // Same title, same day, different time = a correction ("no, 2pm") — move
  // the existing item instead of creating a second one.
  if (tryReschedule_(title, start, end)) {
    stats.updated.push(title);
    return 'Moved: ' + title + ' — now ' + whenStr;
  }
  if (isDuplicate_(title, start, end)) return 'Already handled: ' + title + ' (' + whenStr + ')';

  if (isDeadline) {
    createDeadlineTask_({
      title: title, start: start,
      description: evt.description || '', sourceSubject: 'Reply command'
    });
    stats.added.push(title);
    return 'Task added: ' + title + ' — due ' + whenStr;
  }

  var conflicts = evt.allDay ? [] : findConflicts_(start, end);
  createCalendarEvent_({
    title: title, start: start, end: end, allDay: !!evt.allDay,
    location: evt.location || '', description: evt.description || '',
    sourceSubject: 'Reply command', sourceMsgId: msg.getId()
  });
  stats.added.push(title);
  return 'Added: ' + title + ' — ' + whenStr +
    (conflicts.length ? ' (heads up: overlaps ' + conflicts[0].label + ')' : '');
}

/** The user's words only: cut quoted original text and ">"-prefixed lines. */
function extractReplyText_(body) {
  var text = String(body || '');
  var cut = text.search(/\r?\n\s*On .{1,160}wrote:\s*/);
  if (cut !== -1) text = text.slice(0, cut);
  text = text.split(/\r?\n/)
    .filter(function (line) { return line.indexOf('>') !== 0; })
    .join('\n');
  return text.trim().slice(0, 2000);
}
