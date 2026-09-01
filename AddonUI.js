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
      .setTitle('Pending decisions')
      .setSubtitle(pending.length === 1 ? '1 item' : pending.length + ' items'));

  if (!pending.length) {
    builder.addSection(CardService.newCardSection()
      .addWidget(CardService.newDecoratedText()
        .setStartIcon(CardService.newIconImage().setIcon(CardService.Icon.STAR))
        .setText('<b>All caught up</b>')
        .setBottomLabel('Nothing needs your decision right now.')
        .setWrapText(true))
      .addWidget(lastScanWidget_()));
    return builder.build();
  }

  pending.forEach(function (p) {
    var section = CardService.newCardSection();

    var isDeadline = p.kind === 'deadline';
    var whenLabel = isDeadline
      ? 'Due ' + Utilities.formatDate(new Date(p.startIso), CONFIG.TIMEZONE, 'EEE, MMM d · h:mm a')
      : formatEventWhen_(new Date(p.startIso), new Date(p.endIso), p.allDay);
    var item = CardService.newDecoratedText()
      .setStartIcon(CardService.newIconImage()
        .setIcon(isDeadline ? CardService.Icon.CLOCK : CardService.Icon.INVITE))
      .setTopLabel(whenLabel)
      .setText('<b>' + escapeHtml_(p.title) + '</b>')
      .setWrapText(true);
    if (p.location) item.setBottomLabel(p.location);
    section.addWidget(item);

    if (p.conflicts && p.conflicts.length) {
      section.addWidget(CardService.newTextParagraph().setText(
        '<font color="#b3261e"><b>Conflict:</b> overlaps ' +
        p.conflicts.map(function (c) { return escapeHtml_(c); }).join(', ') + '</font>'));
    }
    if (p.reasoning) {
      section.addWidget(CardService.newTextParagraph()
        .setText('<font color="#5f6368"><i>' + escapeHtml_(p.reasoning) + '</i></font>'));
    }
    if (p.description) {
      section.addWidget(CardService.newTextParagraph().setText(escapeHtml_(p.description)));
    }

    section.addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton()
        .setText(isDeadline ? 'Add task' : 'Add to calendar')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setBackgroundColor('#0b57d0')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('handleAccept')
          .setParameters({ id: p.id })))
      .addButton(CardService.newTextButton()
        .setText('Decline')
        .setOnClickAction(CardService.newAction()
          .setFunctionName('handleDecline')
          .setParameters({ id: p.id }))));

    builder.addSection(section);
  });

  builder.addSection(CardService.newCardSection().addWidget(lastScanWidget_()));
  return builder.build();
}

/** Accept button (card): shared logic + card refresh. */
function handleAccept(e) {
  return actionRefresh_(decidePending_(e.parameters.id, true).message);
}

/** Decline button (card): shared logic + card refresh. */
function handleDecline(e) {
  return actionRefresh_(decidePending_(e.parameters.id, false).message);
}

/**
 * Shared Accept/Decline core used by the Gmail card and reply commands.
 * takePending_ claims the entry first, so a double-tap can't act twice;
 * on failure the entry is restored so the decision isn't swallowed.
 * @return {Object} {ok: boolean, message: string}
 */
function decidePending_(id, accept) {
  var p = takePending_(id);
  if (!p) return { ok: false, message: 'Already handled elsewhere.' };
  try {
    var start = new Date(p.startIso);
    var end = new Date(p.endIso);
    if (!accept) {
      recordDecision_(id, 'declined', start, p.title);
      return { ok: true, message: 'Declined: ' + p.title };
    }
    if (isDuplicate_(p.title, start, end)) {
      recordDecision_(id, 'added', start, p.title); // so reminders don't re-ask
      return { ok: true, message: 'Skipped — "' + p.title + '" is already handled.' };
    }
    if (p.kind === 'deadline') {
      createDeadlineTask_({
        title: p.title, start: start,
        description: p.description, sourceSubject: p.sourceSubject
      });
      return { ok: true, message: 'Task added: ' + p.title };
    }
    createCalendarEvent_({
      title: p.title, start: start, end: end, allDay: !!p.allDay,
      location: p.location, description: p.description,
      sourceSubject: p.sourceSubject, sourceMsgId: p.sourceMsgId
    });
    return { ok: true, message: 'Added: ' + p.title };
  } catch (err) {
    restorePending_(p);
    return { ok: false, message: 'Couldn\'t save "' + p.title + '" — try again. (' + err + ')' };
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
