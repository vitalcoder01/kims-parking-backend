// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 41,
  latestVersionName: '1.9.7',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.9.7.apk',
  notes: 'Generate Ticket and visitor check-in now go straight into Assign Driver instead of back to the Dashboard. Unassigned park tickets also get a repeating reminder every 60s until a driver is assigned or you tap Later to stop it for that ticket.',
};
