// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 34,
  latestVersionName: '1.9.0',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.9.0.apk',
  notes: 'Valet workspace reorganized: Queue is now Dashboard, grouped into Driver assign pending, Driver acceptance pending, Parked Vehicles, and Not completed. Records is now Jobs, with a Map Layout tab and stage filters (At hospital / Transit to parking lot / Parked / Transit to hospital). Live Map is GPS-only now.',
};
