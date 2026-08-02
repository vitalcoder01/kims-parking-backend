// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 30,
  latestVersionName: '1.8.6',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.8.6.apk',
  notes: 'Fixed the in-app notification card getting stuck mid-swipe instead of dismissing — swipe left or right (or flick up) now reliably makes it disappear.',
};
