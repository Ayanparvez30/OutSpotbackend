const admin = require('../firebaseAdmin');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Send notification to a user (saves in DB + pushes via Firebase).
 *
 * @param {number} userId
 * @param {string} type
 * @param {string} title
 * @param {string} description
 * @param {object} data - extra data (e.g., { actorId, friendId, ... })
 * @param {object} [opts]
 * @param {string} [opts.windowKey] - once-per-window idempotency key. When set,
 *   the DB unique index on (userId, type, windowKey) makes a second call for the
 *   same window a no-op that returns null instead of inserting a duplicate. This
 *   holds across processes, unlike a check-then-insert guard.
 * @returns {Promise<object|null>} the created row, or null if it already existed.
 */
async function notifyUser(userId, type, title, description, data = {}, opts = {}) {
  try {
    const { actorId = null, ...restData } = data;
    const windowKey = opts.windowKey ?? null;

    // 1) Save to DB (store actorId + extra metadata)
    let notification;
    try {
      notification = await prisma.notification.create({
        data: {
          userId, type, title, description, actorId, windowKey,
          data: Object.keys(restData).length > 0 ? restData : undefined,
        }
      });
    } catch (createErr) {
      // P2002 = unique violation on (userId, type, windowKey): another process
      // already sent this window's notification. Not an error — just stop here
      // so we don't double-push.
      if (createErr?.code === 'P2002') {
        console.log(`ℹ️ Notification ${type}/${windowKey} already sent to user ${userId}, skipping`);
        return null;
      }
      throw createErr;
    }

    // 2) Set notificationRedDot to true for the user (closed-app case — survives
    //    socket emit miss; client GETs the dot on next open).
    await prisma.user.update({
      where: { id: userId },
      data: { notificationRedDot: true }
    });

    // 3) Realtime: tell the user's socket room there's a new notification
    //    so the bell dot lights up instantly when the app is open. Delivery
    //    is best-effort — DB persist above guarantees the dot for closed app.
    try {
      const { getIO } = require('./socket');
      const io = getIO();
      if (io) io.to(`user:${userId}`).emit('notification', { hasUnread: true });
    } catch (emitErr) {
      console.log('ℹ️ socket emit skipped:', emitErr.message);
    }

    // 4) Load recipient for FCM token
    const user = await prisma.user.findUnique({ where: { id: userId } });

    // Master notification switch: skip ALL FCM push if the user turned it off.
    // null/undefined is treated as ON (default). In-app record is still saved.
    if (user?.fcmToken && user.notificationEnabled !== false) {
      const message = {
        token: user.fcmToken,
        notification: { title, body: description },
        data: {
          type,
          notificationId: String(notification.id),
          // Always stringify FCM data values
          ...Object.fromEntries(
            Object.entries(restData).map(([k, v]) => [k, String(v)])
          ),
          ...(actorId != null ? { actorId: String(actorId) } : {})
        }
      };

      try {
        await admin.messaging().send(message);
        console.log(`✅ Push sent to user ${userId}`);
      } catch (fcmError) {
        // Token invalid = app uninstalled or token expired → clear it
        if (fcmError.code === 'messaging/registration-token-not-registered' ||
            fcmError.code === 'messaging/invalid-registration-token') {
          await prisma.user.update({
            where: { id: userId },
            data: { fcmToken: null },
          });
          console.log(`🧹 Cleared stale FCM token for user ${userId}`);
        } else {
          console.log(`⚠️ FCM delivery failed for user ${userId}:`, fcmError.message);
        }
        console.log(`   Notification still saved to database`);
      }
    } else if (user && user.notificationEnabled === false) {
      console.log(`ℹ️ User ${userId} has notifications OFF, skipping push (in-app saved)`);
    } else {
      console.log(`ℹ️ User ${userId} has no FCM token, skipping push`);
    }

    return notification;
  } catch (err) {
    console.error('❌ notifyUser failed:', err);
    throw err;
  }
}

module.exports = { notifyUser };
