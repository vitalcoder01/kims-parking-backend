// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 4,
  latestVersionName: '1.3',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.3.apk',
  notes: 'Fixed a crash when handing over keys to valet (server-side bug), and added this in-app update prompt.',
};
