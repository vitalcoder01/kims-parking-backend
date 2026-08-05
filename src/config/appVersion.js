// Bumped by hand alongside each APK release (android/app/build.gradle
// versionCode/versionName) so the app can prompt users to update without
// needing its own release to know about the new release.
module.exports = {
  latestVersionCode: 34,
  latestVersionName: '1.9.0',
  apkUrl: 'https://raw.githubusercontent.com/vitalcoder01/kims-parking-frontend/main/releases/KIMS-Parking-v1.9.0.apk',
  notes: 'Valet Dashboard restructured into Driver assign pending / Driver acceptance pending / Parked Vehicles / Not completed. Records renamed to Jobs, now with a Map Layout tab and stage filters (At hospital / Transit → parking lot / Parked / Transit → hospital). Ticket creation and driver assignment are now separate steps — any valet can pick up a freshly-created ticket.',
};
