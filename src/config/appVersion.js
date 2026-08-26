// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
//
// Order matters: push the APK to the frontend repo's releases/ folder
// FIRST, then bump this. Advertising a version whose apkUrl 404s leaves
// every phone stuck on a download that can never finish.
module.exports = {
  latestVersionCode: 49,
  latestVersionName: '1.9.15',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.9.15.apk',
  notes: 'Fixes notifications and vibration, which had stopped working entirely in 1.9.12-1.9.14 (a bad vibration pattern silently disabled every alert). Alarm alerts now buzz a distinctive three-taps-then-long rhythm with looping sound for a full 20 seconds, so arrival/retrieval requests and job assignments are hard to miss.',
};
