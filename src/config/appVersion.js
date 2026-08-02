// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 27,
  latestVersionName: '1.8.3',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.8.3.apk',
  notes: 'The in-app update download now automatically retries if the connection drops mid-download instead of failing outright.',
};
