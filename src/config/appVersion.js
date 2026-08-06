// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 39,
  latestVersionName: '1.9.5',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.9.5.apk',
  notes: 'The update check now catches a new release while the app is already open — on resume from background, and every few minutes if it never backgrounds at all — instead of only at the next full launch. Also removed "No-Show" as a cancel reason on visitor tickets.',
};
