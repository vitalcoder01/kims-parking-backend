// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 29,
  latestVersionName: '1.8.5',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.8.5.apk',
  notes: 'Fixed the in-app update download failing with "Download interrupted" on a weak connection — it now uses Android\'s own download manager, which resumes instead of restarting from scratch. Also redesigned the in-app notification into a floating, swipeable card.',
};
