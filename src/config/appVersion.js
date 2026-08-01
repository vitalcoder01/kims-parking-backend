// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 20,
  latestVersionName: '1.7.6',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.7.6.apk',
  notes: 'Fixed a bug where double-tapping Check In (or Mark Parked) while the app was thinking could create duplicate entries.',
  // v1.7.7 shipped a crash — see the in-app-update-download work in
  // kims-parking-frontend. Gate held here at 1.7.6 (the last known-good
  // build) until it's fixed and re-released.
};
