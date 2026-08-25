// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
//
// Order matters: push the APK to the frontend repo's releases/ folder
// FIRST, then bump this. Advertising a version whose apkUrl 404s leaves
// every phone stuck on a download that can never finish.
module.exports = {
  latestVersionCode: 48,
  latestVersionName: '1.9.14',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.9.14.apk',
  notes: 'Alarms now ring for a full 20 seconds instead of ~3, so arrival/retrieval requests and job assignments are much harder to miss. Doctors and staff can cancel an arrival they already sent. Valets can close out a car that left without anyone requesting it, freeing the slot. Redesigned sign-in, search on the admin Staff and Attendance lists, and a rebuilt Attendance screen.',
};
