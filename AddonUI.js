/**
 * Gmail add-on UI (CardService). One card lists every pending event with
 * Accept / Decline buttons; conflicts are flagged inline. Works from the
 * add-on homepage (desktop side panel) and contextually when any message is
 * open (which is how you reach it on the phone).
 */

/** Homepage trigger (manifest: onHomepage). */
function onHomepage(e) {
  return buildPendingCard_();
}

/** Contextual trigger on message open (manifest: onGmailMessageOpen). */
function onGmailMessageOpen(e) {
  return buildPendingCard_();
}

function buildPendingCard_() {
  var pending = listPending_();
  var builder = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader()
      .setTitle('MailBrah')
      .setSubtitle(pending.length
        ? pending.length + ' event(s) need your decision'
        : 'No pending events')
      .setImageUrl('https://www.gstatic.com/images/icons/material/system/2x/event_googblue_48dp.png'));

  if (!pending.length) {
    builder.addSection(CardService.newCardSection()
      .addWidget(CardService.newTextParagraph()
        .setText('🎉 All caught up. New USC events land here when MailBrah isn\'t sure you want them.'))
      .addWidget(lastScanWidget_()));
    return builder.build();
  }

  pending.forEach(function (p) {
    var section = CardService.newCardSection();

    var isDeadline = p.kind === 'deadline';
    var whenLabel = isDeadline
      ? '📝 Due ' + Utilities.formatDate(new Date(p.startIso), CONFIG.TIMEZONE, 'EEE, MMM d · h:mm a')
      : formatEventWhen_(new Date(p.startIso), new Date(p.endIso), p.allDay);
    section.addWidget(CardService.newDecoratedText()
      .setTopLabel(whenLabel)
      .setText('<b>' + escapeHtml_(p.title) + '</b>')
      .setBottomLabel(p.location ? '📍 ' + p.location : '')
      .setWrapText(true));

    if (p.conflicts && p.conflicts.length) {
      section.addWidget(CardService.newTextParagraph().setText(
        '⚠️ <b><font color="#c5221f">Conflict:</font></b> overlaps ' +
        p.conflicts.map(function (c) { return '"' + escapeHtml_(c) + '"'; }).join(', ')));
    }
    if (p.reasoning) {
      section.addWidget(CardService.newTextParagraph()
        .setText('<i>' + escapeHtml_(p.reasoning) + '</i>'));
    }
    if (p.description) {
      section.addWidget(CardService.newTextParagraph().setText(escapeHtml_(p.description)));
    }

    section.addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText(isDeadline ? '✔ Add task' : '✔ Add to calendar')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setOnClickAction(CardService.newAction()
          .setFunctionName('handleAccept')
          .setParameters({ id: p.id })))
      .addButton(CardService.newTextButton()
        .setText('✖ Decline')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('handleDecline')
          .setParameters({ id: p.id }))));

    builder.addSection(section);
  });

  builder.addSection(CardService.newCardSection().addWidget(lastScanWidget_()));
  return builder.build();
}

/** Accept button: create the event (with a final duplicate check) and refresh. */
function handleAccept(e) {
  var id = e.parameters.id;
  var p = takePending_(id); // claims the entry, so a double-tap can't add twice
  if (!p) return actionRefresh_('Already handled elsewhere.');

  try {
    var start = new Date(p.startIso);
    var end = new Date(p.endIso);
    if (isDuplicate_(p.title, start, end)) {
      recordDecision_(id, 'added', start, p.title); // so reminders don't re-ask
      return actionRefresh_('Skipped — "' + p.title + '" is already handled.');
    }
    if (p.kind === 'deadline') {
      createDeadlineTask_({
        title: p.title, start: start,
        description: p.description, sourceSubject: p.sourceSubject
      });
      return actionRefresh_('Task added: ' + p.title);
    }
    createCalendarEvent_({
      title: p.title, start: start, end: end, allDay: !!p.allDay,
      location: p.location, description: p.description,
      sourceSubject: p.sourceSubject, sourceMsgId: p.sourceMsgId
    });
    return actionRefresh_('Added: ' + p.title);
  } catch (err) {
    restorePending_(p); // don't swallow the decision if Calendar hiccups
    return actionRefresh_('Couldn\'t add "' + p.title + '" — try again. (' + err + ')');
  }
}

/** Decline button: remember the decision so reminder emails don't re-ask. */
function handleDecline(e) {
  var id = e.parameters.id;
  var p = takePending_(id);
  if (!p) return actionRefresh_('Already handled elsewhere.');
  try {
    recordDecision_(id, 'declined', new Date(p.startIso), p.title);
    return actionRefresh_('Declined: ' + p.title);
  } catch (err) {
    restorePending_(p);
    return actionRefresh_('Couldn\'t decline — try again. (' + err + ')');
  }
}

/** Rebuild the card in place and flash a toast. */
function actionRefresh_(message) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(message))
    .setNavigation(CardService.newNavigation().updateCard(buildPendingCard_()))
    .setStateChanged(true)
    .build();
}

function lastScanWidget_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROPS.LAST_RUN);
  var text = raw
    ? 'Last scan: ' + Utilities.formatDate(new Date(Number(raw)), CONFIG.TIMEZONE, 'MMM d, h:mm a')
    : 'No scan yet — run setup() in the Apps Script editor.';
  return CardService.newTextParagraph().setText('<font color="#80868b">' + text + '</font>');
}

function escapeHtml_(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
