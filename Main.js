/**
 * Main pipeline, run by the time-driven trigger (see Setup.js).
 *
 * For each new USC email: extract events with Gemini, then per event —
 *   duplicate            -> skip
 *   'auto_add' + free    -> straight onto the calendar
 *   'auto_add' + conflict-> downgraded to ask_user (you decide, with the
 *                           conflict shown on the card)
 *   'ask_user'           -> pending card in the Gmail add-on
 *   'ignore'             -> dropped
 */
function processInbox() {
  // Never let a manual run overlap the trigger (Properties aren't transactional).
  // If a run is already in flight, ask it to wrap up (it checks the abort flag
  // between emails and saves progress as it goes), then take over.
  var lock = LockService.getScriptLock();
  var props = PropertiesService.getScriptProperties();
  if (!lock.tryLock(2000)) {
    Logger.log('Another run is in flight — asked it to stop; waiting to take over…');
    props.setProperty(PROPS.ABORT, '1');
    try {
      lock.waitLock(120 * 1000);
    } catch (err) {
      props.deleteProperty(PROPS.ABORT);
      Logger.log('The old run didn\'t finish within 2 minutes (probably mid-API-call). Try again shortly.');
      return null;
    }
  }
  props.deleteProperty(PROPS.ABORT); // a leftover flag must not abort THIS run
  try {
    return processInboxLocked_();
  } finally {
    lock.releaseLock();
  }
}

/** True if a newer run has asked this one to stop. */
function abortRequested_() {
  return PropertiesService.getScriptProperties().getProperty(PROPS.ABORT) === '1';
}

function processInboxLocked_() {
  // Stay well under the 6-min execution cap even if Gemini retries slowly;
  // whatever doesn't fit is picked up on the next run.
  var deadline = Date.now() + 3.5 * 60 * 1000;
  var props = PropertiesService.getScriptProperties();
  var label = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL) ||
    GmailApp.createLabel(CONFIG.PROCESSED_LABEL);
  var myEmail = Session.getEffectiveUser().getEmail() || '';

  var threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, CONFIG.MAX_THREADS_PER_RUN);
  var seenIds = getSeenMessageIds_();
  var failCounts = getFailCounts_();
  var prefilter = buildPrefilter_();
  var llmCalls = 0;
  var stats = { emails: 0, added: [], updated: [], pendingNew: [], dupes: 0, ignored: 0, skipped: 0, errors: 0 };

  // Act on reply commands first, so decisions land before new pending items
  // pile on top of them. A failure here never blocks the email scan.
  try {
    processReplies_(stats);
  } catch (err) {
    Logger.log('Reply processing failed (scan continues): %s', err);
  }

  for (var t = 0; t < threads.length; t++) {
    var thread = threads[t];
    var messages = thread.getMessages();
    var threadFullyProcessed = true;

    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      if (seenIds.indexOf(msg.getId()) !== -1) continue;

      // Never feed MailBrah's own notification emails back into the pipeline
      // (relevant when this runs on a usc.edu-hosted account).
      var subject = msg.getSubject() || '';
      if (subject.indexOf('[MailBrah]') === 0 ||
          (myEmail && msg.getFrom().indexOf(myEmail) !== -1)) {
        seenIds.push(msg.getId());
        saveSeenMessageIds_(seenIds);
        continue;
      }

      // Cheap pre-filter: no time/date/event signal anywhere -> skip the AI
      // call entirely. Free, instant, and marked seen so it's never rescanned.
      var body = msg.getPlainBody();
      if (prefilter && !prefilter.test(subject + '\n' + body)) {
        stats.skipped++;
        Logger.log('No time signal — skipping "%s" without AI.', subject);
        seenIds.push(msg.getId());
        saveSeenMessageIds_(seenIds);
        continue;
      }

      if (llmCalls >= CONFIG.MAX_LLM_CALLS_PER_RUN || Date.now() > deadline || abortRequested_()) {
        threadFullyProcessed = false; // pick this thread up next run
        break;
      }

      try {
        llmCalls++;
        stats.emails++;
        Logger.log('Analyzing email %s/%s: "%s"', llmCalls, CONFIG.MAX_LLM_CALLS_PER_RUN, subject);
        var events = extractEventsWithGemini({
          subject: subject,
          from: msg.getFrom(),
          receivedIso: Utilities.formatDate(msg.getDate(), CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss"),
          body: body
        });
        events.forEach(function (evt) {
          handleExtractedEvent_(evt, msg, stats);
        });
        seenIds.push(msg.getId());
        saveSeenMessageIds_(seenIds); // persist per message: a killed run loses nothing
        if (failCounts[msg.getId()]) {
          delete failCounts[msg.getId()];
          saveFailCounts_(failCounts);
        }
      } catch (err) {
        stats.errors++;
        Logger.log('Failed on message "%s": %s', subject, err);
        var fails = (failCounts[msg.getId()] || 0) + 1;
        if (fails >= 3) {
          // Deterministic failure — stop burning quota on it, but leave a trace.
          delete failCounts[msg.getId()];
          seenIds.push(msg.getId());
          saveSeenMessageIds_(seenIds);
          Logger.log('Giving up on "%s" after 3 failed runs; marking as seen.', subject);
        } else {
          failCounts[msg.getId()] = fails;
          threadFullyProcessed = false; // retry this message next run
        }
        saveFailCounts_(failCounts);
      }
    }

    if (threadFullyProcessed) thread.addLabel(label);
    if (llmCalls >= CONFIG.MAX_LLM_CALLS_PER_RUN || Date.now() > deadline) break;
    if (abortRequested_()) {
      Logger.log('Stop requested by a newer run — wrapping up early (progress is saved).');
      break;
    }
  }

  // Gradescope + Brightspace deadline syncs (every few hours; cheap, no LLM
  // calls). A failure in either never affects email processing.
  if (gradescopeConfigured_() && Date.now() < deadline) {
    try {
      processGradescope_(stats);
    } catch (err) {
      Logger.log('Gradescope sync failed (emails unaffected): %s', err);
    }
  }
  if (brightspaceConfigured_() && Date.now() < deadline) {
    try {
      processBrightspace_(stats);
    } catch (err) {
      Logger.log('Brightspace sync failed (emails unaffected): %s', err);
    }
  }

  // Pruning reads the whole property store — a few times a day is plenty.
  var lastPrune = Number(props.getProperty(PROPS.PRUNE_LAST) || 0);
  if (Date.now() - lastPrune > 6 * 3600 * 1000) {
    pruneDecided_();
    props.setProperty(PROPS.PRUNE_LAST, String(Date.now()));
  }
  props.setProperty(PROPS.LAST_RUN, String(Date.now()));

  // Everything else waits for the morning digest; only newly discovered
  // items happening TODAY warrant an immediate email.
  var urgent = stats.pendingNew.filter(function (p) { return p.startsToday; });
  if (urgent.length && CONFIG.SEND_DECISION_NOTIFICATIONS) {
    try {
      sendUrgentNotification_(urgent.map(function (p) { return p.title; }));
    } catch (err) {
      Logger.log('Urgent notification failed (run state already saved): %s', err);
    }
  }
  Logger.log('MailBrah run: %s analyzed, %s skipped by pre-filter, %s added, %s time-updated, %s pending, %s dupes, %s ignored, %s errors',
    stats.emails, stats.skipped, stats.added.length, stats.updated.length,
    stats.pendingNew.length, stats.dupes, stats.ignored, stats.errors);
  return stats;
}

/** Compiles the prefilter patterns into one case-insensitive regex (or null if disabled). */
function buildPrefilter_() {
  if (!CONFIG.PREFILTER_ENABLED || !CONFIG.PREFILTER_PATTERNS.length) return null;
  return new RegExp(CONFIG.PREFILTER_PATTERNS.map(function (p) {
    return '(?:' + p + ')';
  }).join('|'), 'i');
}

/** Route one extracted event to calendar / pending / trash. */
function handleExtractedEvent_(evt, msg, stats) {
  if (evt.decision === 'ignore') { stats.ignored++; return; }

  var start = parseLocalIso_(evt.startLocal);
  var end = parseLocalIso_(evt.endLocal);
  if (!start) { stats.ignored++; return; }
  if (evt.allDay) {
    // end is EXCLUSIVE: 00:00 the day after the last day (schema instructs
    // Gemini likewise). A missing/bad end means a one-day event.
    start = stripTime_(start);
    end = (end && stripTime_(end) > start)
      ? stripTime_(end)
      : new Date(start.getTime() + 24 * 60 * 60 * 1000);
  } else if (!end || end <= start) {
    end = new Date(start.getTime() + 60 * 60 * 1000);
  }

  var now = new Date();
  var horizon = new Date(now.getTime() + CONFIG.MAX_EVENT_HORIZON_DAYS * 24 * 3600 * 1000);
  if (end < now || start > horizon) { stats.ignored++; return; }

  // Same title, same day, different time = a correction ("moved to 5pm"):
  // the existing event/task is moved instead of a second one being created.
  if (tryReschedule_(evt.title, start, end)) { stats.updated.push(evt.title); return; }

  if (isDuplicate_(evt.title, start, end)) { stats.dupes++; return; }

  // Deadlines become Google Tasks, don't occupy time, and can't "conflict".
  var isDeadline = evt.kind === 'deadline';
  var conflicts = (isDeadline || evt.allDay) ? [] : findConflicts_(start, end);
  var wantsAuto = evt.decision === 'auto_add' && evt.confidence >= 0.7;

  if (wantsAuto && conflicts.length === 0) {
    if (isDeadline) {
      createDeadlineTask_({
        title: evt.title, start: start,
        description: evt.description || '', sourceSubject: msg.getSubject()
      });
    } else {
      createCalendarEvent_({
        title: evt.title, start: start, end: end, allDay: !!evt.allDay,
        location: evt.location || '', description: evt.description || '',
        sourceSubject: msg.getSubject(), sourceMsgId: msg.getId()
      });
    }
    stats.added.push(evt.title);
    return;
  }

  // Uncertain (or certain-but-conflicting): queue for the Gmail card.
  var reasoning = evt.reasoning || '';
  if (wantsAuto && conflicts.length) {
    reasoning = 'Would have auto-added, but it conflicts with your calendar.';
  }
  var added = addPending_({
    id: eventFingerprint_(evt.title, start),
    title: evt.title,
    kind: isDeadline ? 'deadline' : 'event',
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    allDay: !!evt.allDay,
    location: evt.location || '',
    description: evt.description || '',
    reasoning: reasoning,
    conflicts: conflicts.map(function (c) { return c.label; }),
    sourceSubject: msg.getSubject(),
    sourceMsgId: msg.getId(),
    createdAt: Date.now()
  });
  if (added) {
    stats.pendingNew.push({
      title: evt.title,
      startsToday: Utilities.formatDate(start, CONFIG.TIMEZONE, 'yyyyMMdd') ===
        Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyyMMdd')
    });
  } else {
    stats.dupes++;
  }
}

/** Immediate email — only for newly discovered items happening TODAY. */
function sendUrgentNotification_(titles) {
  var me = notificationRecipient_();
  if (!me) return;
  var body = [
    'MailBrah just found ' + (titles.length === 1 ? 'something' : titles.length + ' things') +
      ' happening TODAY:',
    '',
    titles.map(function (t) { return '  • ' + t; }).join('\n'),
    '',
    replyHint_(),
    'Everything else waits for the morning digest. Total awaiting decision: ' +
      listPending_().length
  ].join('\n');
  GmailApp.sendEmail(me, '[MailBrah] Happening today — ' + titles.length + ' decision(s)', body);
}

/**
 * Daily digest, fired by its own ~8:30 AM trigger (installed by setup()).
 * One email a day listing everything pending; silent when there is nothing.
 */
function sendDailyDigest() {
  if (!CONFIG.SEND_DECISION_NOTIFICATIONS) return;
  var pending = listPending_();
  if (!pending.length) return;
  var me = notificationRecipient_();
  if (!me) return;
  var lines = pending.map(function (p) {
    var when = p.kind === 'deadline'
      ? 'Due ' + Utilities.formatDate(new Date(p.startIso), CONFIG.TIMEZONE, 'EEE, MMM d · h:mm a')
      : formatEventWhen_(new Date(p.startIso), new Date(p.endIso), p.allDay);
    return '  • ' + when + ' — ' + p.title +
      (p.conflicts && p.conflicts.length ? '  [conflicts with ' + p.conflicts[0] + ']' : '');
  });
  var body = [
    'Good morning — ' + pending.length + ' decision(s) waiting:',
    '',
    lines.join('\n'),
    '',
    replyHint_()
  ].join('\n');
  GmailApp.sendEmail(me, '[MailBrah] Morning digest — ' + pending.length + ' decision(s) waiting', body);
}

function notificationRecipient_() {
  var me = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail();
  if (!me) Logger.log('No user email available; skipping notification.');
  return me;
}

function replyHint_() {
  return 'Just REPLY to this email in plain words and it happens within minutes —\n' +
    'e.g. "add the career fair, decline the rest" or "also add lunch with Sam\n' +
    'Friday noon". Or tap the MailBrah icon at the bottom of this message for\n' +
    'the buttons.';
}

// ---- Seen-message-ID cache and failure counters (trigger-only, under lock) ----

function getSeenMessageIds_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROPS.SEEN_MESSAGES);
  return raw ? JSON.parse(raw) : [];
}

function saveSeenMessageIds_(ids) {
  // Newest last; keep the most recent 300, comfortably > 3 days of USC mail.
  PropertiesService.getScriptProperties()
    .setProperty(PROPS.SEEN_MESSAGES, JSON.stringify(ids.slice(-300)));
}

function getFailCounts_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROPS.FAILS);
  return raw ? JSON.parse(raw) : {};
}

function saveFailCounts_(counts) {
  var ids = Object.keys(counts);
  if (ids.length > 50) {
    ids.slice(0, ids.length - 50).forEach(function (id) { delete counts[id]; });
  }
  PropertiesService.getScriptProperties().setProperty(PROPS.FAILS, JSON.stringify(counts));
}
