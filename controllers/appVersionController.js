const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/// Force-update policy.
///
/// `AppVersionSetting` is append-only: every save is a new row and the newest
/// by `createdAt` is the one in force. Nothing is ever updated in place, so the
/// admin screen can list what was pushed and when, and restoring an old policy
/// is just saving its numbers again.

/// Reads the policy currently in force, or null when none has ever been saved.
async function currentSetting() {
  return prisma.appVersionSetting.findFirst({ orderBy: { createdAt: 'desc' } });
}

/// A policy can only block people who have somewhere to go. With no store URL
/// for their platform, "Update Now" would lead nowhere and the app would be
/// unusable with no way out — so force is reported as off regardless of the
/// switch. This is the safety valve for the app not being on the stores yet.
function effectiveForce(setting, platform) {
  if (!setting || !setting.forceUpdate) return false;
  const url =
    platform === 'ios' ? setting.storeUrlIos : setting.storeUrlAndroid;
  return typeof url === 'string' && url.trim().length > 0;
}

// GET /api/app/version?platform=android&build=16
//
// Deliberately public — the app checks this before login, and a blocked user
// may never reach a screen where they could authenticate.
exports.getAppVersion = async (req, res) => {
  try {
    const platform =
      String(req.query.platform || 'android').toLowerCase() === 'ios'
        ? 'ios'
        : 'android';
    const build = parseInt(req.query.build, 10);

    const setting = await currentSetting();

    // No policy configured yet → nothing to enforce. Answering 200 with
    // updateRequired:false keeps the app's startup path simple; an error here
    // would block launch on a server hiccup.
    if (!setting) {
      return res.json({
        success: true,
        configured: false,
        updateRequired: false,
        forceUpdate: false,
      });
    }

    const force = effectiveForce(setting, platform);
    const storeUrl =
      (platform === 'ios' ? setting.storeUrlIos : setting.storeUrlAndroid) || '';

    // An unreadable build number must not lock anyone out.
    const isOutdated = Number.isFinite(build) && build < setting.minBuild;

    return res.json({
      success: true,
      configured: true,
      minBuild: setting.minBuild,
      latestBuild: setting.latestBuild,
      // What the app should act on: outdated AND force is genuinely usable.
      updateRequired: isOutdated && force,
      // Outdated but not forced — the app may show a dismissible prompt.
      updateAvailable: Number.isFinite(build) && build < setting.latestBuild,
      forceUpdate: force,
      message: setting.message || '',
      storeUrl,
    });
  } catch (e) {
    console.error('getAppVersion error', e);
    // Fail open. A version check that 500s must never stop the app from opening.
    return res.json({
      success: false,
      configured: false,
      updateRequired: false,
      forceUpdate: false,
    });
  }
};

/// Everything ever saved, newest first — the admin history table.
exports.listSettings = async (limit = 50) =>
  prisma.appVersionSetting.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

exports.currentSetting = currentSetting;
exports.effectiveForce = effectiveForce;

/// Saves a new policy row. Callers are the admin panel only.
exports.createSetting = async ({
  minBuild,
  latestBuild,
  forceUpdate,
  message,
  storeUrlAndroid,
  storeUrlIos,
  createdByAdmin,
}) => {
  const min = parseInt(minBuild, 10);
  const latest = parseInt(latestBuild, 10);

  if (!Number.isFinite(min) || min < 1) {
    throw new Error('Minimum build must be a positive number');
  }
  if (!Number.isFinite(latest) || latest < 1) {
    throw new Error('Latest build must be a positive number');
  }
  // Blocking people below a build that doesn't exist yet would lock out
  // everyone, including whoever is about to install the "new" version.
  if (min > latest) {
    throw new Error('Minimum build cannot be greater than the latest build');
  }

  return prisma.appVersionSetting.create({
    data: {
      minBuild: min,
      latestBuild: latest,
      forceUpdate: forceUpdate === true || forceUpdate === 'on',
      message: (message || '').trim().slice(0, 500) || null,
      storeUrlAndroid: (storeUrlAndroid || '').trim().slice(0, 500) || null,
      storeUrlIos: (storeUrlIos || '').trim().slice(0, 500) || null,
      createdByAdmin: (createdByAdmin || '').trim().slice(0, 100) || null,
    },
  });
};
