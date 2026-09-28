/**
 * Daily Encouragement Messages — inbound SMS handler
 *
 * Set this Function as the "A MESSAGE COMES IN" webhook on your Twilio number.
 * It is the only moving part of the service.
 *
 *   HAPPY / START / JOIN / YES  ->  enroll: send the welcome reply, then schedule
 *                                   all 90 messages (30 days x 3) with Twilio's
 *                                   own SendAt scheduling.
 *   STOP (and variants)         ->  cancel every message still queued for them.
 *                                   Twilio also blocks them at the account level.
 *   HELP / INFO                 ->  the registered help message.
 *   anything else               ->  a short reply telling them how to join.
 *
 * Because every message for the whole 30 days is queued at signup, there is no
 * cron job, no database and no server to keep running. Twilio holds the queue.
 *
 * Environment variables required (Functions > Environment Variables):
 *   MESSAGING_SERVICE_SID   MG...   scheduling only works through a Messaging Service
 *
 * Asset required (upload as a PRIVATE asset named messages.private.json):
 *   messages.json — { "days": [ { morning, midday, evening } x30 ] }
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Local delivery times, in TIMEZONE. Add or remove entries to change the daily
// cadence — but if you do, update your registered campaign, your terms page and
// your privacy policy, which all currently state three messages per day.
const SENDS = [
  { slot: 'morning', hour: 6,  minute: 0 },
  { slot: 'midday',  hour: 13, minute: 30 },
  { slot: 'evening', hour: 18, minute: 0 },
];

const TIMEZONE = 'America/New_York';
const RUN_DAYS = 30;

// Twilio requires SendAt to be at least 15 minutes out; keep a safety margin.
const MIN_LEAD_MS = 20 * 60 * 1000;
// Twilio will not accept a SendAt more than 35 days ahead.
const MAX_LEAD_MS = 34 * 24 * 60 * 60 * 1000;

// How many schedule calls to fire at once. Keeps the whole run inside the
// Function's execution limit without tripping API rate limits.
const BATCH_SIZE = 15;

const KEYWORDS = {
  start: ['happy', 'start', 'join', 'yes', 'unstop'],
  stop:  ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout'],
  help:  ['help', 'info'],
};

const REPLY = {
  welcome:  'Daily Encouragement Messages: You are now subscribed to 3 encouragement messages per day. Msg & data rates may apply. Reply HELP for help, STOP to cancel.',
  already:  'Daily Encouragement Messages: You are already subscribed. Reply STOP to cancel, HELP for help.',
  stopped:  'Daily Encouragement Messages: You are unsubscribed and will receive no further messages. Reply START to rejoin.',
  help:     'Daily Encouragement Messages: 3 encouragement messages per day. Contact jflasak@gmail.com. Msg & data rates may apply. Reply STOP to cancel.',
  fallback: 'Daily Encouragement Messages: text HAPPY to subscribe to 3 encouragement messages a day. Msg & data rates may apply. Reply HELP for help.',
};

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * Convert a wall-clock time in TIMEZONE to the correct UTC instant.
 * Tries each plausible UTC offset and keeps the one that renders back to the
 * requested local time, so daylight saving is handled without a date library.
 */
function localToUtc(year, month, day, hour, minute) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });

  for (const offset of [4, 5, 6, 3]) {
    const guess = new Date(Date.UTC(year, month - 1, day, hour + offset, minute));
    const parts = {};
    for (const p of fmt.formatToParts(guess)) parts[p.type] = Number(p.value);
    const renderedHour = parts.hour % 24; // some locales render midnight as 24
    if (
      parts.year === year && parts.month === month && parts.day === day &&
      renderedHour === hour && parts.minute === minute
    ) return guess;
  }
  // Fall back to standard time rather than failing outright.
  return new Date(Date.UTC(year, month - 1, day, hour + 5, minute));
}

/** Calendar date in TIMEZONE, N days from today. */
function localDatePlus(days) {
  const parts = {};
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = Number(p.value);
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// ---------------------------------------------------------------------------
// Twilio helpers
// ---------------------------------------------------------------------------

/** Every message still sitting in the scheduled state for this number. */
async function scheduledFor(client, number) {
  const messages = await client.messages.list({ to: number, limit: 400 });
  return messages.filter((m) => m.status === 'scheduled');
}

function loadDays() {
  const asset = Runtime.getAssets()['/messages.json'];
  if (!asset) throw new Error('Private asset messages.private.json is not uploaded.');
  const parsed = JSON.parse(asset.open());
  if (!parsed.days || !parsed.days.length) throw new Error('messages.json has no days.');
  return parsed.days;
}

/** Build the full 30-day plan, starting tomorrow so every day is complete. */
function buildPlan(days) {
  const now = Date.now();
  const plan = [];

  for (let i = 0; i < RUN_DAYS; i++) {
    const date = localDatePlus(i + 1); // start tomorrow
    const content = days[i % days.length];

    for (const send of SENDS) {
      const body = content[send.slot];
      if (!body) continue;
      const when = localToUtc(date.year, date.month, date.day, send.hour, send.minute);
      const lead = when.getTime() - now;
      if (lead < MIN_LEAD_MS || lead > MAX_LEAD_MS) continue;
      plan.push({ when, body });
    }
  }
  return plan;
}

async function scheduleAll(client, context, number, plan) {
  let scheduled = 0;
  const failures = [];

  for (let i = 0; i < plan.length; i += BATCH_SIZE) {
    const batch = plan.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((item) =>
      client.messages.create({
        to: number,
        messagingServiceSid: context.MESSAGING_SERVICE_SID,
        body: item.body,
        scheduleType: 'fixed',
        sendAt: item.when.toISOString(),
      })
    ));
    for (const r of results) {
      if (r.status === 'fulfilled') scheduled++;
      else failures.push(r.reason && r.reason.message ? r.reason.message : String(r.reason));
    }
  }
  return { scheduled, failures };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

exports.handler = async function (context, event, callback) {
  const twiml = new Twilio.twiml.MessagingResponse();
  const from = event.From;
  const word = String(event.Body || '').trim().toLowerCase().replace(/[^a-z]/g, '');

  if (!from) {
    twiml.message(REPLY.fallback);
    return callback(null, twiml);
  }

  const client = context.getTwilioClient();

  try {
    // --- opt out -----------------------------------------------------------
    // Twilio's own keyword handling already blocks future sends to this number,
    // so delivery stops whether or not this branch runs. Cancelling the queue
    // keeps the logs clean and avoids paying failed-message fees.
    if (KEYWORDS.stop.includes(word)) {
      const queued = await scheduledFor(client, from);
      await Promise.allSettled(queued.map((m) =>
        client.messages(m.sid).update({ status: 'canceled' })
      ));
      console.log(`STOP from ${from}: cancelled ${queued.length} scheduled messages`);
      twiml.message(REPLY.stopped);
      return callback(null, twiml);
    }

    // --- help --------------------------------------------------------------
    if (KEYWORDS.help.includes(word)) {
      twiml.message(REPLY.help);
      return callback(null, twiml);
    }

    // --- enroll ------------------------------------------------------------
    if (KEYWORDS.start.includes(word)) {
      const existing = await scheduledFor(client, from);
      if (existing.length > 0) {
        console.log(`${from} already has ${existing.length} scheduled messages`);
        twiml.message(REPLY.already);
        return callback(null, twiml);
      }

      const plan = buildPlan(loadDays());

      // Send the confirmation through the API first so the subscriber gets it
      // immediately, rather than waiting on 90 scheduling calls.
      await client.messages.create({
        to: from,
        messagingServiceSid: context.MESSAGING_SERVICE_SID,
        body: REPLY.welcome,
      });

      const { scheduled, failures } = await scheduleAll(client, context, from, plan);
      console.log(`Enrolled ${from}: ${scheduled}/${plan.length} scheduled`);
      if (failures.length) console.error(`Schedule failures for ${from}:`, failures.slice(0, 5));

      // The welcome already went out over the API; return empty TwiML so the
      // subscriber does not receive it twice.
      return callback(null, new Twilio.twiml.MessagingResponse());
    }

    // --- anything else -----------------------------------------------------
    twiml.message(REPLY.fallback);
    return callback(null, twiml);

  } catch (err) {
    console.error('handler error:', err && err.message ? err.message : err);
    // Never leave an inbound message unanswered.
    const fallback = new Twilio.twiml.MessagingResponse();
    fallback.message(REPLY.fallback);
    return callback(null, fallback);
  }
};
