// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 32,
  latestVersionName: '1.8.8',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.8.8.apk',
  notes: 'Removed the in-app notification popups, notification tab, and bell icon. Notifications now appear only on the phone\'s own notification tray — the same place every other app shows them — so nothing overlays or clutters the app itself.',
};
