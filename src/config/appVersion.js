// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 19,
  latestVersionName: '1.7.5',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.7.5.apk',
  notes: 'Removed the duplicate Visitor pickups section from the driver app and fixed a data bug where completing a visitor pickup, retrieval, or cancellation could leave a stuck job behind.',
};
