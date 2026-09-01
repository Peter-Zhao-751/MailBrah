/**
 * Gemini API client (free tier, plain REST via UrlFetchApp).
 *
 * Two jobs:
 *  - extractEventsWithGemini(email): pull events/deadlines out of one email.
 *  - interpretReplyWithGemini_(replyText, pending): turn a plain-words reply
 *    to a notification email into decisions on pending items + new events.
 */

var GEMINI_EVENT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short calendar-ready event title' },
    kind: { type: 'string', enum: ['event', 'deadline'], description: '"deadline" for things to submit or complete by a cutoff (homework, applications, forms, registration closes) — startLocal is then the due time. "event" for things to attend.' },
    startLocal: { type: 'string', description: 'Local start time, format YYYY-MM-DDTHH:mm:00 (no timezone offset). For all-day events use YYYY-MM-DDT00:00:00.' },
    endLocal: { type: 'string', description: 'Local end time, same format. If no end time is given, use start + 1 hour. For all-day events, endLocal is 00:00 on the day AFTER the last day (a one-day event on Sep 5 ends 2026-09-06T00:00:00).' },
    allDay: { type: 'boolean' },
    timeGiven: { type: 'boolean', description: 'true if the source stated an explicit clock time; false if only a day was given' },
    location: { type: 'string', description: 'Venue/room/address, or empty string' },
    description: { type: 'string', description: '1-3 sentence summary of what this event is' },
    decision: { type: 'string', enum: ['auto_add', 'ask_user', 'ignore'] },
    reasoning: { type: 'string', description: 'One short sentence: why this decision' },
    confidence: { type: 'number', description: '0-1 confidence that the extracted date/time is correct' }
  },
  required: ['title', 'kind', 'startLocal', 'endLocal', 'allDay', 'timeGiven', 'decision', 'reasoning', 'confidence']
};

var GEMINI_EVENTS_SCHEMA = {
  type: 'object',
  properties: {
    events: { type: 'array', items: GEMINI_EVENT_ITEM_SCHEMA }
  },
  required: ['events']
};

var GEMINI_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      description: 'Accept/decline choices for items on the PENDING list only',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'the exact id of the pending item' },
          accept: { type: 'boolean' }
        },
        required: ['id', 'accept']
      }
    },
    newEvents: {
      type: 'array',
      description: 'Events/deadlines the user asked to add that are NOT on the pending list',
      items: GEMINI_EVENT_ITEM_SCHEMA
    },
    note: { type: 'string', description: 'One short sentence: what was understood, plus anything that could not be matched or was ambiguous' }
  },
  required: ['decisions', 'newEvents', 'note']
};

/**
 * @param {Object} email {subject, from, receivedIso, body}
 * @return {Array<Object>} extracted events (possibly empty)
 */
function extractEventsWithGemini(email) {
  var todayLocal = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");
  var prompt = [
    'You extract calendar events from a university email for one specific student.',
    'Current local date/time (' + CONFIG.TIMEZONE + '): ' + todayLocal,
    '',
    'STUDENT PREFERENCES: ' + CONFIG.USER_PREFERENCES,
    '',
    'Rules:',
    '- Extract only concrete events/deadlines with a resolvable date. If the email',
    '  has none, return an empty events array.',
    '- All times are local to ' + CONFIG.TIMEZONE + ' unless the email says otherwise;',
    '  convert relative dates ("this Friday", "tomorrow") using the current date above.',
    '- An email listing several distinct events yields several entries.',
    '- kind "deadline" = something the student submits/completes by a cutoff',
    '  (homework, problem sets, applications, registration closes) with startLocal',
    '  as the due time; kind "event" = something attended at a place/time.',
    '- Events that already ended: decision "ignore".',
    '- decision "auto_add" ONLY for things the student is personally committed to',
    '  per the preferences. When in doubt between auto_add and ask_user, choose ask_user.',
    '- TITLE CONVENTION (strict): deadlines are "COURSE — Task" (e.g.',
    '  "PHYS 152 — HW 4", "WRIT 150 — AA1 Draft"); events are',
    '  "Organization — Event name" (e.g. "Viterbi — Career Fair",',
    '  "USC Libraries — Study Night"). Infer the course/organization from the',
    '  sender and body; if none is identifiable, use the event name alone.',
    '  NEVER put the location, date, or time in the title — location goes in',
    '  the location field, everything else in description.',
    '- timeGiven: true when the email states a clock time; false when only a date.',
    '',
    'EMAIL',
    'From: ' + email.from,
    'Subject: ' + email.subject,
    'Received: ' + email.receivedIso,
    'Body:',
    truncateForPrompt_(email.body, 9000)
  ].join('\n');

  var parsed = callGemini_(prompt, GEMINI_EVENTS_SCHEMA);
  if (!parsed) return [];
  return (parsed.events || []).filter(function (evt) {
    return evt && evt.title && evt.startLocal;
  });
}

/**
 * Interpret a plain-words reply to a notification email.
 * @param {string} replyText the user's words (quoted text already stripped)
 * @param {Array<Object>} pending current pending items ({id, title, ...})
 * @return {Object|null} {decisions, newEvents, note}
 */
function interpretReplyWithGemini_(replyText, pending) {
  var todayLocal = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");
  var pendingLines = pending.map(function (p, i) {
    var when = Utilities.formatDate(new Date(p.startIso), CONFIG.TIMEZONE, 'EEE MMM d h:mm a');
    return (i + 1) + '. id=' + p.id + ' | ' + p.title + ' | ' + when +
      (p.kind === 'deadline' ? ' (deadline)' : '');
  });
  var prompt = [
    'A student replied to a notification email from their calendar assistant.',
    'Interpret the reply and return the actions to take.',
    'Current local date/time (' + CONFIG.TIMEZONE + '): ' + todayLocal,
    '',
    'PENDING ITEMS (awaiting accept/decline):',
    pendingLines.length ? pendingLines.join('\n') : '(none)',
    '',
    'Rules:',
    '- Match references loosely — a single word or fragment is enough: "career"',
    '  means the career fair item, "alex" means the item mentioning Alex,',
    '  "the quiz" the quiz item. Pick the pending item whose title best matches.',
    '  Use the exact id values in decisions. Only if a reference matches nothing',
    '  or is genuinely ambiguous between two items, skip it and explain in note.',
    '- Pending items the reply does NOT mention: leave them untouched — emit no',
    '  decision for them. Only blanket phrases ("the rest", "everything else",',
    '  "all of them", "decline everything") cover unmentioned items.',
    '- "add"/"yes"/"accept"/"go" => accept: true; "decline"/"no"/"skip"/"ignore" => accept: false.',
    '- Anything the user wants added that is NOT a pending item (e.g. "also add',
    '  dinner with Alex Friday 7pm") goes in newEvents, times local to ' + CONFIG.TIMEZONE + '.',
    '- Times in newEvents: if the user states a clock time, use it EXACTLY and',
    '  set timeGiven true. A bare number is daytime: "at 2" = 2:00 PM (1-7 mean',
    '  PM, 8-11 mean AM). NEVER invent a different time than the one stated.',
    '- If only a day is given ("tomorrow", "Friday") with no clock time: set',
    '  timeGiven false and startLocal to 09:00:00 that day as a placeholder —',
    '  the assistant will slot it into the earliest free time. A deadline with',
    '  no stated time is due 23:59 that day (timeGiven false).',
    '- newEvents titles: course items follow "COURSE — Task"; personal errands',
    '  keep a plain short title ("Get Altoids"). No location/date/time in titles.',
    '- Only act on what the reply actually says. If the reply is not an',
    '  instruction at all, return empty arrays and say so in note.',
    '',
    'REPLY:',
    truncateForPrompt_(replyText, 2000)
  ].join('\n');

  var parsed = callGemini_(prompt, GEMINI_REPLY_SCHEMA);
  if (!parsed) return null;
  var validIds = {};
  pending.forEach(function (p) { validIds[p.id] = true; });
  parsed.decisions = (parsed.decisions || []).filter(function (d) { return d && validIds[d.id]; });
  parsed.newEvents = (parsed.newEvents || []).filter(function (evt) {
    return evt && evt.title && evt.startLocal;
  });
  return parsed;
}

/**
 * Shared Gemini call: model fallback chain + structured-output syntax
 * fallback + retry with backoff. Returns the parsed JSON object, or null if
 * the model returned nothing usable. Throws on transport-level failure.
 */
function callGemini_(prompt, schema) {
  var apiKey = PropertiesService.getScriptProperties().getProperty(PROPS.API_KEY);
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set. Run setApiKey() in Setup.js or add it under Project Settings > Script Properties.');
  }

  var contents = [{ role: 'user', parts: [{ text: prompt }] }];
  // The classic responseMimeType/responseSchema syntax is what the live API
  // actually accepts; the newer documented responseFormat form is the fallback.
  var payloads = [
    {
      contents: contents,
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: schema
      }
    },
    {
      contents: contents,
      generationConfig: {
        temperature: 0.1,
        responseFormat: { text: { mimeType: 'application/json', schema: schema } }
      }
    }
  ];

  // Model fallback: the primary model can shed free-tier load (HTTP 503) or
  // rate-limit (429); when that happens, drop down the chain for this call.
  var models = [CONFIG.GEMINI_MODEL].concat(CONFIG.GEMINI_FALLBACK_MODELS || []);
  var response = null;
  for (var mi = 0; mi < models.length && !response; mi++) {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      models[mi] + ':generateContent';
    for (var i = 0; i < payloads.length && !response; i++) {
      try {
        response = fetchWithRetry_(url, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'x-goog-api-key': apiKey },
          payload: JSON.stringify(payloads[i]),
          muteHttpExceptions: true
        });
      } catch (err) {
        var msg = String(err);
        if (msg.indexOf('HTTP 400') !== -1 && i + 1 < payloads.length) {
          Logger.log('Structured-output syntax rejected; retrying with the alternate form.');
          continue;
        }
        if (/HTTP (503|429)/.test(msg) && mi + 1 < models.length) {
          Logger.log('%s is overloaded — falling back to %s.', models[mi], models[mi + 1]);
          break;
        }
        throw err;
      }
    }
  }
  if (!response) throw new Error('All Gemini models overloaded — will retry next run.');

  var data = JSON.parse(response.getContentText());
  var candidate = data.candidates && data.candidates[0];
  var parts = (candidate && candidate.content && candidate.content.parts) || [];
  // Join all non-"thought" text parts — long JSON can arrive split across parts.
  var text = parts
    .filter(function (p) { return p && p.text && !p.thought; })
    .map(function (p) { return p.text; })
    .join('');
  if (!text) {
    Logger.log('Gemini returned no content: %s', response.getContentText().slice(0, 500));
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (err2) {
    Logger.log('Gemini returned unparseable JSON: %s', text.slice(0, 500));
    return null;
  }
}

/**
 * Fetch with exponential backoff on 429/5xx. Throws on persistent failure.
 * Total sleep is kept short (16s) so a run can't blow the 6-min execution cap.
 */
function fetchWithRetry_(url, options) {
  var delaysMs = [0, 4000, 12000];
  var lastResponse = null;
  for (var i = 0; i < delaysMs.length; i++) {
    if (delaysMs[i] > 0) Utilities.sleep(delaysMs[i]);
    lastResponse = UrlFetchApp.fetch(url, options);
    var code = lastResponse.getResponseCode();
    if (code >= 200 && code < 300) return lastResponse;
    if (code !== 429 && code < 500) break; // non-retryable client error
  }
  throw new Error('Gemini API request failed (HTTP ' + lastResponse.getResponseCode() +
    '): ' + lastResponse.getContentText().slice(0, 300));
}

/** Strip noise and cap length so prompts stay small and cheap. */
function truncateForPrompt_(text, maxChars) {
  var cleaned = String(text || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/https?:\/\/\S{60,}/g, '[link]')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) + '\n[truncated]' : cleaned;
}
