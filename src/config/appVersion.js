// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 40,
  latestVersionName: '1.9.6',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.9.6.apk',
  notes: 'Android back button/gesture now works correctly throughout the app — closes a sub-screen or form instead of skipping past it to switch tabs or exit unexpectedly.',
};
