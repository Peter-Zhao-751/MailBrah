/**
 * Gradescope deadline sync (screen-scrape — Gradescope has no API or calendar
 * feed, and sends no assignment/due-date emails, so this is the only way).
 *
 * Flow (mirrors the community scrapers, verified against the live site):
 *   GET /login  -> CSRF token + session cookie
 *   POST /login -> 302 = success; remember_me=1 yields a long-lived cookie
 *   GET /account -> course list (newest term)
 *   GET /courses/<id> -> #assignments-student-table rows with
 *                        <time class="submissionTimeChart--dueDate" datetime>
 *
 * Unsubmitted future assignments become Google Tasks via createDeadlineTask_.
 * Cookies are cached in Script Properties; login is repeated only on expiry.
 * Everything is wrapped so a Gradescope failure never affects email processing.
 */

var GS_BASE = 'https://www.gradescope.com';

function gradescopeConfigured_() {
  var p = PropertiesService.getScriptProperties();
  return !!(p.getProperty(PROPS.GS_EMAIL) && p.getProperty(PROPS.GS_PASSWORD));
}

/**
 * Scrape and sync. Called from the locked trigger run; also fine manually.
 * @param {Object} stats the run's stats object (adds task titles to .added)
 */
function processGradescope_(stats) {
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty(PROPS.GS_LAST) || 0);
  if (Date.now() - last < CONFIG.GS_SCAN_EVERY_HOURS * 3600 * 1000) return;

  var courses = gsListCourses_();
  Logger.log('Gradescope: scanning %s course(s)…', courses.length);
  var now = Date.now();
  var horizon = now + CONFIG.MAX_EVENT_HORIZON_DAYS * 24 * 3600 * 1000;

  courses.forEach(function (course) {
    gsListAssignments_(course.id).forEach(function (a) {
      if (a.submitted) return;                       // already turned in
      if (a.due.getTime() < now) return;             // past due
      if (a.due.getTime() > horizon) return;
      var title = course.shortName + ' — ' + a.title;
      var end = new Date(a.due.getTime() + 60 * 60 * 1000);
      if (tryReschedule_(title, a.due, end)) {       // due time changed on Gradescope
        stats.updated.push('📝 ' + title);
        return;
      }
      if (isDuplicate_(title, a.due, end)) return;   // task/email already handled it
      createDeadlineTask_({
        title: title,
        start: a.due,
        description: 'Gradescope assignment for ' + course.shortName,
        sourceSubject: 'Gradescope: ' + course.shortName
      });
      stats.added.push('📝 ' + title);
      Logger.log('Gradescope: task added — %s (due %s)', title,
        Utilities.formatDate(a.due, CONFIG.TIMEZONE, 'MMM d h:mm a'));
    });
  });

  props.setProperty(PROPS.GS_LAST, String(Date.now()));
}

// ---- Courses & assignments ----

/** [{id, shortName}] for the newest term on the dashboard. */
function gsListCourses_() {
  var html = gsFetch_('/account');
  // The first coursesForTerm block on the page is the newest term.
  var block = html;
  var split = html.split('courseList--coursesForTerm');
  if (split.length > 1) {
    block = split[1];
    var nextTerm = block.indexOf('courseList--term');
    if (nextTerm !== -1) block = block.slice(0, nextTerm);
  }
  var courses = [];
  var re = /<a[^>]*href="\/courses\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  var m;
  while ((m = re.exec(block)) !== null && courses.length < CONFIG.GS_MAX_COURSES) {
    if (m[0].indexOf('courseBox-new') !== -1) continue;
    var short = /courseBox--shortname[^>]*>([^<]+)</.exec(m[2]);
    courses.push({ id: m[1], shortName: short ? short[1].trim() : 'Course ' + m[1] });
  }
  return courses;
}

/** [{title, due:Date, submitted:boolean}] for one course (student view). */
function gsListAssignments_(courseId) {
  var html = gsFetch_('/courses/' + courseId);
  var table = /<table[^>]*id="assignments-student-table"[\s\S]*?<\/table>/.exec(html);
  if (!table) {
    Logger.log('Gradescope: no student assignments table on course %s (markup change or instructor role).', courseId);
    return [];
  }
  var out = [];
  table[0].split(/<tr[\s>]/).slice(1).forEach(function (row) {
    // First dueDate <time> is the real deadline; a second one is the late cutoff.
    var due = /submissionTimeChart--dueDate"[^>]*datetime="([^"]+)"/.exec(row);
    if (!due) return; // header row or undated assignment
    var dueDate = gsParseDate_(due[1]);
    if (!dueDate) return;
    var th = /<th[\s\S]*?<\/th>/.exec(row);
    var title = th ? th[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (!title) return;
    var submitted = /submissionStatus-complete|submissionStatus--score/.test(row);
    out.push({ title: title, due: dueDate, submitted: submitted });
  });
  return out;
}

/** Gradescope datetimes look like "2026-04-20 23:59:00 -0700" (ISO also accepted). */
function gsParseDate_(s) {
  var m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*([+-]\d{2}):?(\d{2})/.exec(String(s));
  if (m) {
    return new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] +
      m[7] + ':' + m[8]);
  }
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ---- Auth plumbing (UrlFetchApp has no cookie jar — managed by hand) ----

/** Authenticated GET; transparently re-logs-in once if the session expired. */
function gsFetch_(path) {
  var props = PropertiesService.getScriptProperties();
  var cookieStr = props.getProperty(PROPS.GS_COOKIES) || gsLogin_();
  for (var attempt = 0; attempt < 2; attempt++) {
    var response = UrlFetchApp.fetch(GS_BASE + path, {
      headers: { Cookie: cookieStr, Accept: 'text/html' },
      followRedirects: false,
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    var headers = response.getAllHeaders();
    var location = String(headers['Location'] || headers['location'] || '');
    var loggedOut = code === 401 ||
      (code >= 300 && code < 400 && location.indexOf('/login') !== -1);
    if (code === 200) return response.getContentText();
    if (!loggedOut) throw new Error('Gradescope GET ' + path + ' returned HTTP ' + code);
    cookieStr = gsLogin_(); // session expired — retry once with a fresh login
  }
  throw new Error('Gradescope session could not be established for ' + path);
}

/** Full login: CSRF handshake, then POST credentials. Caches the cookies. */
function gsLogin_() {
  var props = PropertiesService.getScriptProperties();
  var email = props.getProperty(PROPS.GS_EMAIL);
  var password = props.getProperty(PROPS.GS_PASSWORD);
  if (!email || !password) {
    throw new Error('Gradescope credentials not set — run setGradescopeCredentials() in Setup.');
  }

  var loginPage = UrlFetchApp.fetch(GS_BASE + '/login', {
    headers: { Accept: 'text/html' },
    muteHttpExceptions: true
  });
  var cookies = {};
  gsMergeCookies_(cookies, loginPage);
  var html = loginPage.getContentText();
  var token = /name="authenticity_token"[^>]*value="([^"]+)"/.exec(html) ||
    /value="([^"]+)"[^>]*name="authenticity_token"/.exec(html);
  if (!token) throw new Error('Gradescope login page had no CSRF token (markup change?).');

  var response = UrlFetchApp.fetch(GS_BASE + '/login', {
    method: 'post',
    followRedirects: false,
    muteHttpExceptions: true,
    headers: { Cookie: gsCookieHeader_(cookies), Accept: 'text/html' },
    payload: {
      utf8: '✓',
      authenticity_token: token[1],
      'session[email]': email,
      'session[password]': password,
      'session[remember_me]': '1', // long-lived cookie: avoids logging in every scan
      commit: 'Log In',
      'session[remember_me_sso]': '0'
    }
  });
  if (response.getResponseCode() !== 302) {
    // 200 = re-rendered login form = bad credentials.
    throw new Error('Gradescope login failed (HTTP ' + response.getResponseCode() + '). ' +
      'Check email/password — SSO users must first set a native password via ' +
      '"Forgot password" on gradescope.com with their school email.');
  }
  gsMergeCookies_(cookies, response);
  var header = gsCookieHeader_(cookies);
  props.setProperty(PROPS.GS_COOKIES, header);
  Logger.log('Gradescope: logged in, session cached.');
  return header;
}

function gsMergeCookies_(map, response) {
  var headers = response.getAllHeaders();
  var setCookie = headers['Set-Cookie'] || headers['set-cookie'];
  if (!setCookie) return map;
  if (!Array.isArray(setCookie)) setCookie = [setCookie];
  setCookie.forEach(function (c) {
    var pair = String(c).split(';')[0];
    var i = pair.indexOf('=');
    if (i > 0) map[pair.slice(0, i)] = pair.slice(i + 1);
  });
  return map;
}

function gsCookieHeader_(map) {
  return Object.keys(map).map(function (k) { return k + '=' + map[k]; }).join('; ');
}
