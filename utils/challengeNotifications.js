// utils/challengeNotifications.js
//
// Sends the once-per-window "here's your challenge" notification.
//
// Exactly one DAILY_CHALLENGE per user per day and one WEEKLY_CHALLENGE per
// user per week, both fired by the morning crons in server.js (08:00 Boston
// daily, Sunday 09:00 Boston weekly).
//
// Idempotency is the DB's job, not ours: Notification has a unique index on
// (userId, type, windowKey), so a re-run of the cron — or two app instances
// firing it at once — inserts nothing the second time. notifyUser() swallows
// the resulting P2002 and returns null.
//
// Selection uses pickForWindow(), which is read-only. getAssignedChallenge()
// used to notify as a side effect; that is what made the same challenge arrive
// twice — once when the user opened the app, once when a cron hit the same
// read path.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const { notifyUser } = require('./notificationService');
const {
  pickForWindow,
  resolveZone,
  dateKeyInZone,
  weekKeyInZone,
} = require('./challenges');

// Notifying every user is one write per user. Cap in-flight work so a large
// user table can't saturate the connection pool at 08:00.
const BATCH_SIZE = 50;

async function chunked(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

/**
 * Send the challenge notification for the current window to every eligible user.
 *
 * @param {'DAILY'|'WEEKLY'} frequency
 * @param {string|null} timezone - defaults to the app timezone (Boston).
 * @returns {Promise<{sent:number, alreadySent:number, failed:number, challengeId:number|null}>}
 */
async function sendChallengeNotice(frequency, timezone = null) {
  const zone = resolveZone(timezone);
  const now = new Date();
  const label = frequency.toLowerCase();

  const picked = await pickForWindow(prisma, frequency, zone, now);
  if (!picked.challenge) {
    console.log(`ℹ️ No ${label} challenge live for this window — nothing to notify.`);
    return { sent: 0, alreadySent: 0, failed: 0, challengeId: null };
  }

  const challenge = picked.challenge;
  const type = frequency === 'DAILY' ? 'DAILY_CHALLENGE' : 'WEEKLY_CHALLENGE';
  // Must match pickForWindow's key so the unique index lines up with the window
  // the challenge was actually picked for.
  const windowKey = frequency === 'DAILY' ? dateKeyInZone(now, zone) : weekKeyInZone(now, zone);

  // Everyone except globally banned users. Users without an FCM token still get
  // the in-app row — notifyUser() skips only the push.
  const users = await prisma.user.findMany({
    where: { isBanned: false },
    select: { id: true },
  });

  let sent = 0, alreadySent = 0, failed = 0;

  await chunked(users, BATCH_SIZE, async (user) => {
    try {
      const created = await notifyUser(
        user.id,
        type,
        challenge.title,
        challenge.description,
        {
          challengeId: challenge.id,
          frequency,
          points: challenge.points,
          tier: challenge.tier,
          windowKey,
        },
        { windowKey },
      );
      if (created) sent++; else alreadySent++;
    } catch (err) {
      failed++;
      console.error(`❌ ${label} challenge notify failed for user ${user.id}:`, err.message);
    }
  });

  console.log(
    `✅ ${label} challenge notice — challenge=${challenge.id} window=${windowKey} ` +
    `sent=${sent} alreadySent=${alreadySent} failed=${failed}`
  );
  return { sent, alreadySent, failed, challengeId: challenge.id };
}

const sendDailyChallengeNotice  = (tz = null) => sendChallengeNotice('DAILY', tz);
const sendWeeklyChallengeNotice = (tz = null) => sendChallengeNotice('WEEKLY', tz);

module.exports = {
  sendChallengeNotice,
  sendDailyChallengeNotice,
  sendWeeklyChallengeNotice,
};
