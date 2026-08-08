// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 42,
  latestVersionName: '1.9.8',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.9.8.apk',
  notes: 'Fixed real vehicle numbers being rejected for states other than AP — RTO validation was capped at stale per-state limits.',
};
