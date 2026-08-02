// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 28,
  latestVersionName: '1.8.4',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.8.4.apk',
  notes: 'Fixed a visitor ticket briefly reappearing after confirming handover, fixed a staff retrieval request being mislabeled as already having a driver, and fixed "already taken" errors when assigning a driver to a scheduled staff/doctor retrieval — valets can now assign a driver to any retrieval request as soon as it comes in.',
};
