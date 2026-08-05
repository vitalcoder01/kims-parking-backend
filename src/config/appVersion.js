// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 35,
  latestVersionName: '1.9.1',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.9.1.apk',
  notes: 'Fixes the Jobs page stage-filter chips (At hospital / Transit → parking lot / Parked / Transit → hospital) rendering as tall ovals instead of flat pills.',
};
