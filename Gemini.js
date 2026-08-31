/**
 * Gemini API client (free tier, plain REST via UrlFetchApp).
 *
 * Extracts calendar events from one email. Returns an array of event objects:
 *   { title, startLocal, endLocal, allDay, location, description,
 *     decision: 'auto_add'|'ask_user'|'ignore', reasoning, confidence }
 * startLocal/endLocal are local wall-clock ISO strings, e.g. "2026-09-05T14:00:00".
 */

var GEMINI_EVENTS_SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short calendar-ready event title' },
          kind: { type: 'string', enum: ['event', 'deadline'], description: '"deadline" for things to submit or complete by a cutoff (homework, applications, forms, registration closes) — startLocal is then the due time. "event" for things to attend.' },
          startLocal: { type: 'string', description: 'Local start time, format YYYY-MM-DDTHH:mm:00 (no timezone offset). For all-day events use YYYY-MM-DDT00:00:00.' },
          endLocal: { type: 'string', description: 'Local end time, same format. If the email gives no end time, use start + 1 hour. For all-day events, endLocal is 00:00 on the day AFTER the last day (a one-day event on Sep 5 ends 2026-09-06T00:00:00).' },
          allDay: { type: 'boolean' },
          location: { type: 'string', description: 'Venue/room/address, or empty string' },
          description: { type: 'string', description: '1-3 sentence summary of what this event is' },
          decision: { type: 'string', enum: ['auto_add', 'ask_user', 'ignore'] },
          reasoning: { type: 'string', description: 'One short sentence: why this decision' },
          confidence: { type: 'number', description: '0-1 confidence that the extracted date/time is correct' }
        },
        required: ['title', 'kind', 'startLocal', 'endLocal', 'allDay', 'decision', 'reasoning', 'confidence']
      }
    }
  },
  required: ['events']
};

/**
 * @param {Object} email {subject, from, receivedIso, body}
 * @return {Array<Object>} extracted events (possibly empty)
 */
function extractEventsWithGemini(email) {
  var apiKey = PropertiesService.getScriptProperties().getProperty(PROPS.API_KEY);
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set. Run setApiKey() in Setup.js or add it under Project Settings > Script Properties.');
  }

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
    '- Keep titles short and scannable (e.g. "Career Fair — Viterbi", "PHYS 152 Midterm").',
    '',
    'EMAIL',
    'From: ' + email.from,
    'Subject: ' + email.subject,
    'Received: ' + email.receivedIso,
    'Body:',
    truncateForPrompt_(email.body, 9000)
  ].join('\n');

  // The classic responseMimeType/responseSchema syntax is what the live API
  // actually accepts (the newer documented responseFormat form gets a 400 on
  // current models), so it goes first; responseFormat stays as a fallback in
  // case Google ever removes the legacy form.
  var contents = [{ role: 'user', parts: [{ text: prompt }] }];
  var payloads = [
    {
      contents: contents,
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_EVENTS_SCHEMA
      }
    },
    {
      contents: contents,
      generationConfig: {
        temperature: 0.1,
        responseFormat: {
          text: { mimeType: 'application/json', schema: GEMINI_EVENTS_SCHEMA }
        }
      }
    }
  ];

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    CONFIG.GEMINI_MODEL + ':generateContent';

  var response = null;
  for (var i = 0; i < payloads.length; i++) {
    try {
      response = fetchWithRetry_(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': apiKey },
        payload: JSON.stringify(payloads[i]),
        muteHttpExceptions: true
      });
      break;
    } catch (err) {
      var isSchemaSyntaxError = String(err).indexOf('HTTP 400') !== -1 && i + 1 < payloads.length;
      if (!isSchemaSyntaxError) throw err;
      Logger.log('Structured-output syntax rejected; retrying with the alternate form.');
    }
  }

  var data = JSON.parse(response.getContentText());
  var candidate = data.candidates && data.candidates[0];
  var parts = (candidate && candidate.content && candidate.content.parts) || [];
  // Join all non-"thought" text parts — long JSON can arrive split across parts.
  var text = parts
    .filter(function (p) { return p && p.text && !p.thought; })
    .map(function (p) { return p.text; })
    .join('');
  if (!text) {
    Logger.log('Gemini returned no content for "%s": %s', email.subject,
      response.getContentText().slice(0, 500));
    return [];
  }

  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err2) {
    Logger.log('Gemini returned unparseable JSON for "%s": %s', email.subject, text.slice(0, 500));
    return [];
  }
  return (parsed.events || []).filter(function (evt) {
    return evt && evt.title && evt.startLocal;
  });
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
