// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 36,
  latestVersionName: '1.9.2',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.9.2.apk',
  notes: 'Every button that saves, deletes, or confirms something now shows a loading state and blocks a second tap while it\'s working — fixes double-submit risks on Reset Password, Delete Account, and a few other spots.',
};
