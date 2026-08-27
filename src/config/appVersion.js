/*
 * Which build each role should be running.
 *
 * Every role has its own release channel, so a change made for doctors can
 * go to doctors without moving anyone else. Shipping to one role is a
 * one-line edit here — no app release is involved, because the phone asks
 * this endpoint what it should be on.
 *
 * The APK still has to exist first. Push it to the frontend repo's
 * releases/ folder on main, THEN point a channel at it. A channel naming a
 * version whose apkUrl 404s leaves those phones stuck on a download that
 * can never finish, with the update gate refusing to let them past.
 */

const APK_BASE_URL =
  'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases';

/*
 * A release, named once and pointed at by whichever roles are on it.
 *
 * The URL is derived from the version name rather than written out, which
 * removes the sharpest edge in this file: a channel that names one version
 * but links the APK of another. That mismatch is invisible in review — the
 * numbers are in different strings — and it ships the wrong build to a
 * whole role. Deriving it makes the mistake unrepresentable.
 */
const release = (versionCode, versionName, notes) => ({
  latestVersionCode: versionCode,
  latestVersionName: versionName,
  apkUrl: `${APK_BASE_URL}/KIMS-Parking-v${versionName}.apk`,
  notes,
});

// ── Releases ─────────────────────────────────────────────────────────────
// Add a new constant per release; don't edit an old one. These are what the
// channels below point at.

const V1_9_15 = release(
  49,
  '1.9.15',
  'Fixes notifications and vibration, which had stopped working entirely in 1.9.12-1.9.14 (a bad vibration pattern silently disabled every alert). Alarm alerts now buzz a distinctive three-taps-then-long rhythm with looping sound for a full 20 seconds, so arrival/retrieval requests and job assignments are hard to miss.',
);

const V1_9_16 = release(
  50,
  '1.9.16',
  'Much smaller download — 37 MB, down from 68 MB — and a lighter app: screens no longer redraw every time a driver location update arrives. Valet records gain Today / Yesterday / This week / This month filters.',
);

const V1_9_17 = release(
  51,
  '1.9.17',
  'Fixes screens occasionally showing older information — two refreshes could overwrite each other, and a live update could be undone by a refresh already in flight. Adds a quiet on-screen assistant that watches for problems and reports faults automatically.',
);

// ── Channels ─────────────────────────────────────────────────────────────
/*
 * To ship to one role: add the release constant above, then point that
 * role's line at it. Leave every other line alone.
 *
 *   doctor: V1_9_XX,     <- only doctors are prompted
 *
 * To ship to everyone, point all five lines at the same release.
 *
 * Roles do not drift apart forever, because a build is the whole app: when
 * valets later move to a release that came after the doctor-only one, they
 * pick up that doctor work too. Divergence is temporary by construction —
 * what you are choosing is who gets disturbed now, not who gets the code
 * eventually.
 *
 * Every role is listed explicitly and that is enforced below. A role
 * missing from here would silently inherit DEFAULT and quietly stop
 * receiving its own releases, which is the kind of bug you only find when
 * someone complains they never got an update.
 */
const BY_ROLE = {
  admin: V1_9_17,
  valet: V1_9_17,
  driver: V1_9_17,
  doctor: V1_9_17,
  staff: V1_9_17,
};

/*
 * For a phone that has not said who it is.
 *
 * The version check runs before login (see UpdateGate), so a fresh install
 * and a signed-out phone both land here, as does every older APK in the
 * field that calls this endpoint with no role at all. Keep it on the
 * release the broadest set of users is on — it is what someone sees at the
 * login screen, before their own channel can apply.
 */
const DEFAULT = V1_9_17;

/*
 * The floor. No build below this is allowed to keep running, whatever its
 * channel says.
 *
 * This exists because of per-role channels, not in spite of them. Holding a
 * role back is the useful half of this and also the dangerous half: a
 * channel nobody revisits quietly turns into phones running a build from
 * months ago against an API that has moved on. The floor bounds how far
 * back any channel can drift, independent of whoever last edited it.
 *
 * Raise it when you ship something the backend genuinely stops supporting
 * older clients through — a removed endpoint, a changed payload shape.
 */
const MINIMUM_SUPPORTED_VERSION_CODE = 49;

// ── Wiring ───────────────────────────────────────────────────────────────

const KNOWN_ROLES = ['admin', 'valet', 'driver', 'doctor', 'staff'];

// Fail at boot, not in the field. A channel that is missing, malformed, or
// below the floor is a release mistake, and the only safe time to find out
// is before the process starts serving it to phones.
for (const role of KNOWN_ROLES) {
  const c = BY_ROLE[role];
  if (!c) throw new Error(`appVersion: no channel for role "${role}"`);
  if (!c.latestVersionCode || !c.latestVersionName || !c.apkUrl) {
    throw new Error(`appVersion: channel for "${role}" is incomplete`);
  }
  if (c.latestVersionCode < MINIMUM_SUPPORTED_VERSION_CODE) {
    throw new Error(
      `appVersion: channel for "${role}" is ${c.latestVersionCode}, below the floor ` +
      `${MINIMUM_SUPPORTED_VERSION_CODE} — those phones would be blocked, sent to that ` +
      `APK, install it, and fail the same check forever`,
    );
  }
}

/**
 * What this role's app should be running.
 *
 * An unknown or missing role resolves to DEFAULT — see its note above for
 * why that path is normal rather than exceptional.
 */
function resolveFor(role) {
  return {
    ...(BY_ROLE[role] || DEFAULT),
    minimumSupportedVersionCode: MINIMUM_SUPPORTED_VERSION_CODE,
  };
}

/** Every channel at a glance — for the admin console or a deploy check. */
function channelReport() {
  return {
    default: DEFAULT.latestVersionName,
    minimumSupportedVersionCode: MINIMUM_SUPPORTED_VERSION_CODE,
    roles: Object.fromEntries(
      KNOWN_ROLES.map(r => [r, {
        versionCode: BY_ROLE[r].latestVersionCode,
        versionName: BY_ROLE[r].latestVersionName,
      }]),
    ),
  };
}

// DEFAULT is spread at the top level so this module still reads as the plain
// {latestVersionCode, latestVersionName, apkUrl, notes} object it used to
// be — anything requiring it directly keeps working.
module.exports = {
  ...DEFAULT,
  minimumSupportedVersionCode: MINIMUM_SUPPORTED_VERSION_CODE,
  resolveFor,
  channelReport,
  KNOWN_ROLES,
};
