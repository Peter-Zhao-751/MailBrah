# MailBrah

MailBrah collects USC deadlines and events from Gmail, Brightspace, and Gradescope, then puts them somewhere I will actually see them: Google Calendar and Google Tasks.

## Why I built it

There is no single place where USC students can reliably see everything they need to do.

Some professors use Brightspace. Others use Gradescope. Clubs announce events through email. Career fairs, workshops, guest speakers, RSVP confirmations, and schedule changes arrive in the same inbox as newsletters and promotions.

I kept losing useful events in that mix. By the time I remembered a club meeting or opened an announcement again, it had often already happened.

MailBrah is my attempt to fix that. It watches the places where USC work already appears and turns the useful parts into calendar events or tasks. Required commitments can be added automatically. Optional events wait for a decision instead of silently filling the calendar.

## What it does

MailBrah runs as a personal Google Apps Script attached to your Google account.

| Source | What MailBrah reads | What it creates |
|---|---|---|
| Gmail | Recent messages from USC senders that mention a date, time, event, or deadline | Calendar events, Google Tasks, or pending decisions |
| Brightspace | Your private D2L calendar feed | Tasks for due dates, events for exams, and decisions for optional timed events |
| Gradescope | Upcoming assignments from your current courses | Google Tasks for unsubmitted assignments |
| Your replies | Plain-language commands sent in response to MailBrah emails | Accepted events, declined events, new events, or new deadlines |

By default, the main scan runs every five minutes. Gradescope is checked at most every three hours, and Brightspace is checked at most once per hour.

## How MailBrah decides what to do

Gemini extracts concrete dates, times, locations, deadlines, and event names from relevant email.

Each extracted item receives one of three decisions:

- `auto_add` is used for things you appear committed to, such as exams, registered classes, appointments, RSVP confirmations, and hard academic deadlines.
- `ask_user` is used for optional events such as club meetings, career fairs, workshops, social events, and guest speakers.
- `ignore` is used for marketing, fundraising, surveys, general newsletters, and announcements without a usable date.

The behavior is controlled by `USER_PREFERENCES` in `Config.js`, so these categories can be changed without rewriting the rest of the project.

MailBrah also checks your calendar before automatically adding a timed event. If the time conflicts with something already there, the event is moved to the pending queue and you decide what happens.

Deadlines do not become fake hour-long calendar blocks. They become Google Tasks in your default task list. Google Tasks stores the due date but not an exact due time, so MailBrah includes the stated time in the task title.

If the Tasks service is unavailable, MailBrah creates an all-day calendar event as a fallback.

## What daily use looks like

Committed events and clear academic deadlines appear automatically.

Optional events collect in a pending queue. MailBrah sends one morning digest around 8:30 AM every day. It lists anything waiting for a decision, or confirms that nothing is waiting and when the last inbox scan ran. If it discovers an undecided event happening today, it sends an immediate email instead of waiting for the next morning.

You can make decisions in two ways.

### Reply to the email

Reply to a MailBrah notification using normal language:

```text
add the career fair, decline the rest
```

```text
decline the workshop. also add dinner with Alex Friday at 7pm
```

Gemini matches your reply against the pending items. MailBrah performs the requested actions during the next scan and replies in the same thread with a confirmation.

A reply can also create a new event that was never in the pending queue. If you give a day but no time, MailBrah looks for the earliest free one-hour slot between the configured start and end of your day.

### Use the Gmail add-on

The Gmail add-on displays every pending item with:

- Its date and time
- Its location
- Gemini's reason for asking
- Any calendar conflict
- An Add to calendar or Add task button
- A Decline button

On desktop Gmail, the add-on appears in the right sidebar. In the Gmail mobile app, it can appear at the bottom of an open message. Mobile availability for self-installed test deployments depends on the Gmail client.

## How the pieces fit together

```text
USC email
    |
    v
Date and event prefilter
    |
    v
Gemini extraction
    |
    +---- required and conflict-free ----> Calendar or Tasks
    |
    +---- optional or conflicting -------> Pending queue
    |
    +---- irrelevant --------------------> Ignored

Brightspace calendar feed ----+
                               |
Gradescope assignment pages --+----> Duplicate check ----> Calendar or Tasks
```

The prefilter avoids sending ordinary email to Gemini when it contains no sign of a date, time, event, or deadline. This saves API calls and keeps routine scans quick.

## Duplicate protection and corrections

MailBrah checks for duplicates at several points.

1. Processed Gmail message IDs are remembered, and completed threads receive the `mailbrah-processed` label.
2. Added and declined items receive a fingerprint based on their normalized title and start time.
3. Similar titles within about 30 minutes of the same start time are treated as likely duplicates.
4. MailBrah checks the live calendar for overlapping events with similar titles. This can catch events that were added manually.
5. If an item with the same title appears again on the same day with a different time, MailBrah attempts to move the existing event or task.

Declined items are remembered too. A reminder email for the same club event should not ask you again.

Automatic corrections only work reliably when the title and date stay the same. If an event moves to another day, MailBrah may create a new item because recurring course titles make cross-date matching risky.

## Setup

### Requirements

You need:

- A Google account with Gmail, Calendar, Tasks, and Apps Script access
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
- USC email delivered to the Gmail account where MailBrah will run
- A few minutes to create and authorize the Apps Script project

The script can only read the Gmail inbox and write to the calendar belonging to the account where it is installed.

If USC restricts Apps Script or Google Workspace add-ons on your school account, you can forward USC email to a personal Gmail account and install MailBrah there.

### 1. Create the Apps Script project

1. Open [Google Apps Script](https://script.google.com).
2. Create a new project named `MailBrah`.
3. Open Project Settings.
4. Enable the option to show the `appsscript.json` manifest.
5. Replace the generated manifest with the `appsscript.json` from this repository.
6. Create one Apps Script file for every `.js` file in this repository. The Apps Script editor will save them with the `.gs` extension.
7. Paste the contents of each file into its matching Apps Script file.
8. Save the project.

Copy all of these files:

```text
AddonUI.js
Brightspace.js
CalendarSync.js
Config.js
Deadlines.js
Gemini.js
Gradescope.js
Main.js
PendingStore.js
Replies.js
Setup.js
appsscript.json
```

The source is split into ordinary Apps Script files and does not require a build step.

If you already use `clasp`, you can create or link a standalone Apps Script project and push the repository from the command line.

### 2. Add the Gemini API key

The API key belongs in Apps Script's Script Properties, not in the source code.

1. Open Project Settings.
2. Find Script Properties.
3. Add a property named `GEMINI_API_KEY`.
4. Paste your API key as the value.

`setApiKey()` in `Setup.js` provides another option, but Script Properties are safer because they do not require temporarily putting the key in a source file.

### 3. Review the configuration

Open `Config.js` before running setup.

The most useful settings are:

| Setting | Default | Purpose |
|---|---:|---|
| `SEARCH_QUERY` | USC mail from the last 3 days | Controls which Gmail messages are considered |
| `CALENDAR_ID` | `primary` | Selects the destination calendar |
| `TIMEZONE` | `America/Los_Angeles` | Controls parsing and display of dates |
| `TRIGGER_EVERY_MINUTES` | `5` | Controls the inbox scan interval |
| `DIGEST_HOUR` | `8` | Sets the morning digest hour |
| `PENDING_MAX_AGE_HOURS` | `48` | Controls how long unanswered items remain pending |
| `DAY_START_HOUR` | `9` | Earliest hour used when a reply does not include a time |
| `DAY_END_HOUR` | `22` | End of the scheduling window |
| `USER_PREFERENCES` | USC student defaults | Tells Gemini what to add, ask about, or ignore |
| `BRIGHTSPACE_ICS_URL` | Empty | Enables Brightspace when a feed URL is supplied |

Keep `TIMEZONE` synchronized with the `timeZone` field in `appsscript.json`.

The repository currently uses `gemini-3.7-flash`, with `gemini-3.5-flash` and `gemini-3.5-flash-lite` as fallbacks. Model availability and rate limits can change, so check the current [Gemini model list](https://ai.google.dev/gemini-api/docs/models) and your limits in [Google AI Studio](https://aistudio.google.com).

### 4. Authorize and start MailBrah

Run `setup()` from the Apps Script editor.

The function:

1. Makes a small Gemini request to verify the API key.
2. Creates the `mailbrah-processed` Gmail label.
3. Installs the recurring inbox trigger.
4. Installs the daily digest trigger.

Google will ask for access to Gmail, Calendar, Tasks, external requests, and trigger management. Review the requested permissions before approving them.

After setup finishes, run:

```text
dryRunLatest()
```

This reads your newest USC email and logs Gemini's extracted events without changing Gmail, Calendar, or Tasks.

Then run:

```text
processInbox()
```

This performs the first real scan.

### 5. Install the Gmail add-on

1. Open Deploy in the Apps Script editor.
2. Choose Test deployments.
3. Install the project as a Google Workspace add-on.
4. Open Gmail and find the MailBrah icon in the right sidebar.

The add-on is optional. Reply commands and notification emails still work without it.

## Gradescope setup

Gradescope support is optional.

Gradescope does not provide a calendar feed for this use case, so MailBrah signs in and reads the student assignment tables. This depends on Gradescope's HTML and may stop working if the site changes.

If you normally use USC single sign-on, first set a native Gradescope password through the "Forgot password?" page using your USC email. This does not replace your USC password.

Add these Script Properties:

```text
GS_EMAIL
GS_PASSWORD
```

You can also use `setGradescopeCredentials()` in `Setup.js`, but do not leave real credentials in the source file.

Run:

```text
testGradescope()
```

The test logs the courses and upcoming unsubmitted assignments it finds. It does not create tasks.

Once configured, the normal inbox scan checks Gradescope at most every three hours. By default it reads up to eight courses from the newest term shown on the account page. Submitted and past-due assignments are skipped.

## Brightspace setup

Brightspace support is optional and uses D2L's official per-user calendar feed.

In Brightspace:

1. Open Calendar.
2. Open Calendar Settings.
3. Enable the calendar feed.
4. Choose Subscribe.
5. Select All Calendars and Tasks.
6. Copy the generated URL.
7. Paste it into `BRIGHTSPACE_ICS_URL` in `Config.js`.

Run:

```text
testBrightspace()
```

The test fetches the feed and logs how each entry would be handled. It does not create tasks or events.

MailBrah treats feed entries as follows:

- Entries ending in `- Due` or `- Ends` become tasks.
- All-day items, including many quizzes, become tasks due at 11:59 PM.
- Timed exams and tests become calendar events when there is no conflict.
- Other timed entries go to the pending queue.
- Entries ending in `- Available` are ignored.

The feed URL contains a private token. Treat it like a password. Do not commit your personalized `Config.js` to a public repository. Regenerate the feed in Brightspace if the URL leaks.

## Privacy and cost

MailBrah runs inside your Google account using Google Apps Script. There is no separate MailBrah server.

It still sends data to other services:

- Relevant USC email text is sent to the Gemini API for extraction.
- Gradescope credentials and session cookies are stored in Apps Script Script Properties when that integration is enabled.
- The Brightspace calendar URL contains a token that grants access to your feed.
- Gmail, Calendar, and Tasks data is accessed through the permissions in `appsscript.json`.

Google states that content submitted through the Gemini free tier may be used to improve its products. Paid-tier content is handled differently. Review the current [Gemini pricing and data-use information](https://ai.google.dev/gemini-api/docs/pricing) before connecting sensitive email.

MailBrah is designed to fit within the Gemini free tier and normal consumer Apps Script quotas. Exact limits vary and can change. Check the official [Apps Script quota page](https://developers.google.com/apps-script/guides/services/quotas) and your active Gemini limits instead of relying on fixed numbers in this README.

If the Google Cloud project associated with your Gemini key has no billing account, API usage cannot create a Gemini bill. Linking billing changes that assumption.

## Diagnostics and test helpers

`Setup.js` includes several functions for checking the installation.

| Function | What it does |
|---|---|
| `dryRunLatest()` | Extracts events from the newest USC email without writing anything |
| `runDiagnostics()` | Checks Gemini, Gmail, Calendar, Tasks, triggers, integrations, and stored state |
| `testGradescope()` | Lists upcoming Gradescope assignments without creating tasks |
| `testBrightspace()` | Classifies Brightspace feed entries without creating anything |
| `testTaskCreation()` | Creates one real test task |
| `seedTestCard()` | Creates sample pending items and sends a test notification |
| `clearTestCard()` | Removes artifacts created by the card and task tests |
| `processInbox()` | Runs the complete production scan immediately |
| `resetAllState()` | Clears MailBrah's stored memory but leaves Gmail labels and calendar items in place |

Use `resetAllState()` carefully. Previously created calendar events and tasks remain after the state is cleared, so scanning the same messages again can produce duplicates.

## Troubleshooting

### Nothing happens after setup

Open Executions in the Apps Script editor and look for recent `processInbox` runs or errors. You can also run `runDiagnostics()`.

### `GEMINI_API_KEY is not set`

Add `GEMINI_API_KEY` under Project Settings and Script Properties, then run `setup()` again.

### An email was skipped

The default Gmail query only considers recent mail from USC domains. It also excludes processed threads and MailBrah's own messages.

Review `SEARCH_QUERY`, `PREFILTER_ENABLED`, and `PREFILTER_PATTERNS` in `Config.js`.

To reprocess a message, remove its `mailbrah-processed` label and clear the corresponding stored state. Be careful with `resetAllState()` because it affects every remembered message and decision.

### Gradescope stopped syncing

Run `testGradescope()` and inspect the execution log. Common causes include an expired login, incorrect native credentials, or a Gradescope HTML change.

A Gradescope failure does not stop Gmail or Brightspace processing.

### Brightspace stopped syncing

Run `testBrightspace()`. If the feed cannot be fetched, confirm that calendar feeds are still enabled and regenerate the private URL.

A Brightspace failure does not stop Gmail or Gradescope processing.

### The Gmail card is missing on a phone

Force-close and reopen the Gmail app after installing the test deployment. The add-on homepage is available in desktop Gmail, while mobile access normally appears at the bottom of an open message.

Self-installed test deployments are not guaranteed to appear in every mobile Gmail environment. Reply commands remain available even when the card is missing.

### A duplicate appeared

Duplicate matching is intentionally conservative. A heavily renamed event or one moved to another day can look like a new item.

MailBrah can automatically correct the time of a same-title item on the same date. Cross-date changes should be checked manually.

## Project structure

| File | Responsibility |
|---|---|
| `Config.js` | User settings, model selection, scan intervals, and property names |
| `Main.js` | Inbox scanning, event routing, notifications, and trigger pipeline |
| `Gemini.js` | Structured event extraction, reply interpretation, and API retries |
| `CalendarSync.js` | Calendar writes, conflict checks, duplicate detection, and corrections |
| `Deadlines.js` | Google Task creation and calendar fallback |
| `PendingStore.js` | Storage and expiration of pending decisions |
| `Replies.js` | Plain-language email commands and confirmations |
| `AddonUI.js` | Gmail add-on cards and decision buttons |
| `Gradescope.js` | Gradescope login, course parsing, and assignment sync |
| `Brightspace.js` | Brightspace calendar feed parsing and classification |
| `Setup.js` | Installation, diagnostics, test helpers, and state reset |
| `appsscript.json` | Apps Script runtime, permissions, services, and add-on configuration |

## Current limitations

MailBrah is a personal, single-user project rather than a hosted service.

Gemini can misunderstand an email, especially when dates are vague or an announcement contains several unrelated events. The conflict check and pending queue reduce the impact, but they do not replace checking your calendar and task list.

Gradescope support relies on screen scraping. Brightspace support only sees items included in the calendar feed. Gmail processing only sees messages matched by the configured search.

Pending items expire after 48 hours by default, and the queue stores no more than 40 items. These limits keep old announcements from accumulating indefinitely.

The project is tuned for one USC student's workflow. The useful part is that the preferences, search query, timing, and calendar destination all live in `Config.js`, so another student can adjust it without changing the pipeline.
