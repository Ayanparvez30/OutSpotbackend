// utils/challenges.js
const { DateTime } = require('luxon');
const { notifyUser } = require('../utils/notificationService'); // Import notification service

function resolveZone(userZone) {
  return userZone || process.env.APP_TIMEZONE || 'America/New_York';
}
function startOfDayInZone(now = new Date(), zone) {
  return DateTime.fromJSDate(now, { zone }).startOf('day').toUTC().toJSDate();
}
function endOfDayInZone(now = new Date(), zone) {
  return DateTime.fromJSDate(now, { zone }).endOf('day').toUTC().toJSDate();
}
// AFTER (US week: Sunday–Saturday)
function getWeekStartEndInZone(now = new Date(), zone) {
  const dt = DateTime.fromJSDate(now, { zone });
  const sundayStart = dt.minus({ days: dt.weekday % 7 }).startOf('day');
  const saturdayEnd = sundayStart.plus({ days: 6 }).endOf('day'); // ✅ Sat 23:59:59.999
  return { startUTC: sundayStart.toUTC().toJSDate(), endUTC: saturdayEnd.toUTC().toJSDate() };
}
function dateKeyInZone(now = new Date(), zone) {
  return DateTime.fromJSDate(now, { zone }).toFormat('yyyy-LL-dd');
}
function weekKeyInZone(now = new Date(), zone) {
  const dt = DateTime.fromJSDate(now, { zone });
  const sundayStart = dt.minus({ days: dt.weekday % 7 }).startOf('day');
  return sundayStart.toFormat('yyyy-LL-dd'); // label by week start (Sunday)
}
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t ^ (t >>> 7)) * (t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededPick(array, seedStr) {
  if (!array.length) return null;
  const seed = xmur3(seedStr)();
  const rand = mulberry32(seed);
  const idx = Math.floor(rand() * array.length);
  return array[idx];
}
// The "already notified?" read and the notify write are not atomic, so two
// concurrent requests for the same user could both miss and both notify.
// Serialize per user+window key; the guard below then sees the first write.
const notifyLocks = new Map();
async function maybeNotify(prisma, userId, assign, freq, zone) {
  if (!assign || !assign.challenge) return;
  const lockKey = `${userId}:${freq}`;
  const prev = notifyLocks.get(lockKey) || Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(() => notifyOnce(prisma, userId, assign, freq, zone));
  notifyLocks.set(lockKey, run);
  try {
    await run;
  } finally {
    if (notifyLocks.get(lockKey) === run) notifyLocks.delete(lockKey);
  }
}

async function notifyOnce(prisma, userId, assign, freq, zone) {
  const challenge = assign.challenge;
  const type = freq === 'DAILY' ? 'DAILY_CHALLENGE' : 'WEEKLY_CHALLENGE';
  const today = new Date();
  let start, end;
  if (freq === 'DAILY') {
    start = startOfDayInZone(today, zone);
    end = endOfDayInZone(today, zone);
  } else {
    const week = getWeekStartEndInZone(today, zone);
    start = week.startUTC;
    end = week.endUTC;
  }

  // Add unique constraint check for notifications
  const existing = await prisma.notification.findFirst({
    where: {
      userId,
      type,
      title: challenge.title,
      createdAt: { gte: start, lte: end },
    },
  });

  if (!existing) {
    // Send push notification
    await notifyUser(
      userId,
      type,
      challenge.title,
      challenge.description,
      { challengeId: challenge.id }
    );
  }
}
// Resolve which challenge is live for the current window. An admin schedule
// override (ChallengeSchedule) wins; otherwise fall back to the deterministic
// date-seeded pick from the eligible active pool. Pure/read-only — no notify.
// Returns { challenge, windowKey, source: 'scheduled' | 'auto' | 'none' }.
async function pickForWindow(prisma, frequency, zone, now = new Date()) {
  const windowKey = frequency === 'DAILY' ? dateKeyInZone(now, zone) : weekKeyInZone(now, zone);

  // 1) Admin override pinned to this exact window?
  // Guard: if the Prisma client predates the ChallengeSchedule model (migration
  // not yet run / client not regenerated after a deploy), skip overrides and
  // fall through to the auto-pick instead of crashing the challenge endpoint.
  if (prisma.challengeSchedule) {
    const sched = await prisma.challengeSchedule.findUnique({
      where: { frequency_windowKey: { frequency, windowKey } },
      include: { challenge: true },
    });
    if (sched && sched.challenge) {
      return { challenge: sched.challenge, windowKey, source: 'scheduled' };
    }
  }

  // 2) Deterministic seeded pick. Scheduling constraints (weekend-only,
  //    seasonal) are applied BEFORE the pick so an invalid challenge is never
  //    surfaced.
  const list = await prisma.challenge.findMany({
    where: { frequency, isActive: true },
    orderBy: { id: 'asc' },
  });
  const ctx = nowContext(zone, now);
  const eligible = list.filter(c => challengeMatchesNow(c, ctx));
  if (!eligible.length) return { challenge: null, windowKey, source: 'none' };
  const challenge = seededPick(eligible, `${frequency}:${windowKey}`);
  return { challenge, windowKey, source: 'auto' };
}

async function getAssignedChallenge(prisma, userId, frequency, zone, now = new Date()) {
  const picked = await pickForWindow(prisma, frequency, zone, now);
  if (!picked.challenge) return { challenge: null, windowKey: picked.windowKey };
  // Create notifications for assigned challenges if not already present
  await maybeNotify(prisma, userId, { challenge: picked.challenge }, frequency, zone);
  return { challenge: picked.challenge, windowKey: picked.windowKey };
}

// Window key for an explicit "yyyy-LL-dd" date string (used by admin
// scheduling). DAILY → that date; WEEKLY → the Sunday week-start containing it.
function windowKeyForDate(frequency, dateStr, zone) {
  const dt = DateTime.fromISO(dateStr, { zone });
  if (!dt.isValid) return null;
  if (frequency === 'DAILY') return dt.toFormat('yyyy-LL-dd');
  return dt.minus({ days: dt.weekday % 7 }).startOf('day').toFormat('yyyy-LL-dd');
}
// Current weekday + season in the app timezone — used to filter out
// challenges whose scheduling constraint doesn't match today.
function nowContext(zone, now = new Date()) {
  const dt = DateTime.fromJSDate(now, { zone });
  const weekday = dt.weekday % 7; // luxon: 1=Mon..7=Sun; %7 → Mon=1..Sat=6, Sun=0
  const isWeekend = weekday === 0 || weekday === 6;
  const month = dt.month; // 1-12
  let season;
  if (month >= 6 && month <= 8) season = 'summer';
  else if (month >= 9 && month <= 11) season = 'fall';
  else if (month === 12 || month <= 2) season = 'winter';
  else season = 'spring';
  return { weekday, isWeekend, month, season };
}

// True when a challenge row passes the scheduling constraints for `nowCtx`.
// weekendOnly=true rows are blocked Mon-Fri. season='summer' rows are blocked
// outside summer. Unset / null constraints always pass.
function challengeMatchesNow(challenge, nowCtx) {
  if (!challenge) return false;
  if (challenge.weekendOnly && !nowCtx.isWeekend) return false;
  if (challenge.season && challenge.season !== nowCtx.season) return false;
  return true;
}

function timeRemainingMs(frequency, zone, now = new Date()) {
  const dt = DateTime.fromJSDate(now, { zone });
  if (frequency === 'DAILY') {
    return Math.max(0, dt.endOf('day').toMillis() - dt.toMillis());
  }
  const sundayStart = dt.minus({ days: dt.weekday % 7 }).startOf('day');
  const saturdayEnd = sundayStart.plus({ days: 6 }).endOf('day'); // ✅
  return Math.max(0, saturdayEnd.toMillis() - dt.toMillis());
}
// Read-only preview of which challenge is *currently selected* for the given
// frequency right now — the same deterministic, date-seeded pick the app uses
// in getAssignedChallenge, minus the per-user notification. Selection is
// user-independent (seed = frequency:windowKey), so every user sees this same
// challenge today. Used by the admin panel to show "today's live daily /
// this week's live weekly". MUST keep the same `orderBy: { id: 'asc' }` as
// getAssignedChallenge so the seeded index resolves to the identical challenge.
async function previewActiveChallenge(prisma, frequency, zone, now = new Date()) {
  return pickForWindow(prisma, frequency, zone, now);
}

module.exports = {
  resolveZone,
  startOfDayInZone,
  endOfDayInZone,
  getWeekStartEndInZone,
  dateKeyInZone,
  weekKeyInZone,
  getAssignedChallenge,
  previewActiveChallenge,
  pickForWindow,
  windowKeyForDate,
  timeRemainingMs,
  nowContext,
  challengeMatchesNow,
};
