// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 23,
  latestVersionName: '1.7.9',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.7.9.apk',
  notes: 'Fixed the in-app update download, which was silently falling back to opening the browser every time instead of actually downloading and installing.',
};
