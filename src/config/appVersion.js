// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 17,
  latestVersionName: '1.7.3',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.7.3.apk',
  notes: 'Fixed duplicate visitor/token cards, fixed a stuck "driver already assigned" error, and visitor jobs now show up on the queue immediately. New: Cancel Assign lets you free a driver who hasn\'t accepted yet without cancelling the whole job.',
};
