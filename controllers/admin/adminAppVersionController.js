const appVersion = require('../appVersionController');

/// Admin screen for the mobile force-update policy.
///
/// Saves are append-only (see `AppVersionSetting`): the form writes a new row
/// and the newest row is what the app enforces. "Restore" re-saves an old row's
/// numbers as a new one, so history is never rewritten and a mistake is always
/// one click from being undone.

exports.index = async (req, res) => {
  try {
    const [current, history] = await Promise.all([
      appVersion.currentSetting(),
      appVersion.listSettings(50),
    ]);

    res.render('admin/pages/appVersion/index', {
      layout: 'admin/layouts/main',
      title: 'App Version',
      current,
      history,
      // Surfaced so the page can explain why a policy marked "force" is not
      // actually blocking anyone.
      androidForceLive: appVersion.effectiveForce(current, 'android'),
      iosForceLive: appVersion.effectiveForce(current, 'ios'),
    });
  } catch (err) {
    console.error('App version page error:', err);
    req.flash('error', 'Failed to load app version settings');
    res.redirect('/admin/dashboard');
  }
};

exports.save = async (req, res) => {
  try {
    const created = await appVersion.createSetting({
      minBuild: req.body.minBuild,
      latestBuild: req.body.latestBuild,
      forceUpdate: req.body.forceUpdate,
      message: req.body.message,
      storeUrlAndroid: req.body.storeUrlAndroid,
      storeUrlIos: req.body.storeUrlIos,
      createdByAdmin: req.session?.admin?.username || 'admin',
    });

    // Say plainly whether anyone is actually blocked, because "force" being on
    // is not the same as force being in effect.
    const blocking = appVersion.effectiveForce(created, 'android');
    req.flash(
      'success',
      blocking
        ? `Saved. Builds below ${created.minBuild} are now blocked on Android.`
        : `Saved. Nobody is blocked yet — turn on Force update and set a store link to enforce it.`,
    );
  } catch (err) {
    console.error('Save app version error:', err);
    req.flash('error', err.message || 'Failed to save');
  }
  res.redirect('/admin/app-version');
};

/// Copies an earlier row's values into a new row.
exports.restore = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const history = await appVersion.listSettings(200);
    const old = history.find((h) => h.id === id);
    if (!old) {
      req.flash('error', 'That version entry no longer exists');
      return res.redirect('/admin/app-version');
    }

    await appVersion.createSetting({
      minBuild: old.minBuild,
      latestBuild: old.latestBuild,
      forceUpdate: old.forceUpdate,
      message: old.message,
      storeUrlAndroid: old.storeUrlAndroid,
      storeUrlIos: old.storeUrlIos,
      createdByAdmin: req.session?.admin?.username || 'admin',
    });
    req.flash('success', `Restored the policy from entry #${id}.`);
  } catch (err) {
    console.error('Restore app version error:', err);
    req.flash('error', err.message || 'Failed to restore');
  }
  res.redirect('/admin/app-version');
};
