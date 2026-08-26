// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
//
// Order matters: push the APK to the frontend repo's releases/ folder
// FIRST, then bump this. Advertising a version whose apkUrl 404s leaves
// every phone stuck on a download that can never finish.

// The release every role gets unless it is explicitly pinned below.
const BASE = {
  latestVersionCode: 49,
  latestVersionName: '1.9.15',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.9.15.apk',
  notes: 'Fixes notifications and vibration, which had stopped working entirely in 1.9.12-1.9.14 (a bad vibration pattern silently disabled every alert). Alarm alerts now buzz a distinctive three-taps-then-long rhythm with looping sound for a full 20 seconds, so arrival/retrieval requests and job assignments are hard to miss.',
};

/*
 * Per-role overrides.
 *
 * Empty is the intended steady state, and that is the point: every role on
 * BASE means exactly one client version in the field, which is what lets
 * the API change both sides in a single commit. The moment two roles sit on
 * different versions, the backend has to speak to both of them at once, and
 * that obligation lasts until they converge again.
 *
 * So pin a role here only for a deliberate, temporary divergence:
 *
 *   - shipping a valet-only fix to valets first, before it reaches everyone
 *   - holding one role back on a release that turned out to break for them
 *
 * and collapse it back into BASE once the release is everywhere. A pin left
 * behind by accident is a permanent compatibility tax nobody remembers
 * agreeing to.
 *
 * Any subset of BASE's keys works — what you omit falls through to BASE, so
 * pinning just a version code without restating the URL is a mistake
 * waiting to happen. Pin apkUrl whenever you pin a version.
 *
 * Roles are the same strings the app's auth uses: admin, valet, driver,
 * doctor, staff.
 */
const BY_ROLE = {
  // valet: {
  //   latestVersionCode: 51,
  //   latestVersionName: '1.9.17',
  //   apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.9.17.apk',
  //   notes: 'Valet-only pilot of the new records date filters.',
  // },
};

/*
 * The floor. No build below this is allowed to keep running, whatever its
 * role says.
 *
 * This exists because of BY_ROLE, not in spite of it. Holding a role back is
 * the useful half of role-scoped releases and also the dangerous half --
 * a pin that nobody revisits quietly turns into a phone running a build
 * from months ago against an API that has moved on. The floor bounds how
 * far back any hold can drift, independent of whoever wrote the pin.
 *
 * Raise it when you ship something the backend genuinely stops supporting
 * older clients through -- a removed endpoint, a changed payload shape.
 */
const MINIMUM_SUPPORTED_VERSION_CODE = 49;

/**
 * What this role's app should be running.
 *
 * An unknown or missing role resolves to BASE, which matters more than it
 * looks: the version check runs before login (see UpdateGate), so a fresh
 * install and a signed-out phone both land here, and every APK already in
 * the field calls this endpoint with no role at all.
 */
function resolveFor(role) {
  const pin = BY_ROLE[role];

  // A pin below the floor is unwinnable, so it is refused rather than
  // served: the phone would be blocked, sent to the pinned APK, install it,
  // fail the same floor check again, and loop with no way out — an update
  // gate that can never be satisfied is worse than no gate at all. The
  // floor wins and the role falls back to BASE.
  const usable = pin && (pin.latestVersionCode ?? BASE.latestVersionCode) >= MINIMUM_SUPPORTED_VERSION_CODE
    ? pin
    : {};

  return {
    ...BASE,
    ...usable,
    minimumSupportedVersionCode: MINIMUM_SUPPORTED_VERSION_CODE,
  };
}

// BASE is spread at the top level too so this module still reads as the
// plain {latestVersionCode, latestVersionName, apkUrl, notes} object it used
// to be -- anything requiring it directly keeps working.
module.exports = {
  ...BASE,
  minimumSupportedVersionCode: MINIMUM_SUPPORTED_VERSION_CODE,
  resolveFor,
};
