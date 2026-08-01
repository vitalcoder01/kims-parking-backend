// One-time data reset — wipes all operational/transactional data and keeps
// only Users (and Driver profiles, with their state reset back to fresh).
//
// KEEPS, untouched:
//   - User            (logins, roles, employee/card codes)
//   - Setting         (admin config: accept timeout, retrieval lead time, etc.)
//
// KEEPS but RESETS to a clean state:
//   - Driver          status -> 'available', currentTaskId -> null
//
// WIPES completely (all rows deleted):
//   - ParkingSlot     (the whole physical layout — re-create it after this runs)
//   - ParkingTask     (every parking/retrieval job, active and historical)
//   - Visitor         (every visitor/patient check-in)
//   - Notification    (notification history)
//   - Attendance      (staff check-in/check-out history)
//   - ArrivalNotice   ("I'm on my way" notices)
//   - DeviceToken     (push tokens — every device re-registers on next open)
//
// SAFE BY DEFAULT: running this with no flags only PRINTS what it would do
// and how many rows of each kind exist right now. Nothing is deleted unless
// you pass --confirm.
//
// Usage:
//   DATABASE_URL="<real prod connection string>" node scripts/reset-data.js            (dry run — counts only)
//   DATABASE_URL="<real prod connection string>" node scripts/reset-data.js --confirm   (actually deletes)
//
// Run this from wherever DATABASE_URL points at the database you actually
// want reset — e.g. Render's shell (already has the production DATABASE_URL
// in its environment, so you can omit the inline var there), or your own
// machine with the real connection string exported temporarily.

const prisma = require('../src/config/database');

async function main() {
  const confirm = process.argv.includes('--confirm');

  const [slots, tasks, visitors, notifications, attendance, arrivals, deviceTokens, drivers, users] =
    await Promise.all([
      prisma.parkingSlot.count(),
      prisma.parkingTask.count(),
      prisma.visitor.count(),
      prisma.notification.count(),
      prisma.attendance.count(),
      prisma.arrivalNotice.count(),
      prisma.deviceToken.count(),
      prisma.driver.count(),
      prisma.user.count(),
    ]);

  console.log('Current row counts:');
  console.log(`  ParkingSlot:    ${slots}  -> will be DELETED`);
  console.log(`  ParkingTask:    ${tasks}  -> will be DELETED`);
  console.log(`  Visitor:        ${visitors}  -> will be DELETED`);
  console.log(`  Notification:   ${notifications}  -> will be DELETED`);
  console.log(`  Attendance:     ${attendance}  -> will be DELETED`);
  console.log(`  ArrivalNotice:  ${arrivals}  -> will be DELETED`);
  console.log(`  DeviceToken:    ${deviceTokens}  -> will be DELETED`);
  console.log(`  Driver:         ${drivers}  -> KEPT, status reset to 'available', currentTaskId cleared`);
  console.log(`  User:           ${users}  -> KEPT, untouched`);
  console.log('  Setting:        KEPT, untouched');

  if (!confirm) {
    console.log('\nDry run only — nothing was deleted. Re-run with --confirm to actually do this.');
    return;
  }

  console.log('\n--confirm passed. Deleting now...');

  // Order matters — delete rows that HOLD a foreign key before the rows
  // they point at, so nothing ever references an already-deleted row:
  //   ParkingSlot.taskId -> ParkingTask.id
  //   ParkingTask.visitorId -> Visitor.id
  //   ParkingTask.driverId / Visitor.driverId -> Driver.id (Driver is kept,
  //     so no ordering constraint there, but tasks/visitors go before the
  //     driver reset regardless for clarity)
  await prisma.parkingSlot.deleteMany({});
  await prisma.parkingTask.deleteMany({});
  await prisma.visitor.deleteMany({});
  await prisma.notification.deleteMany({});
  await prisma.attendance.deleteMany({});
  await prisma.arrivalNotice.deleteMany({});
  await prisma.deviceToken.deleteMany({});
  await prisma.driver.updateMany({ data: { status: 'available', currentTaskId: null } });

  console.log('Done. Users and Settings untouched; Drivers reset to available/idle; everything else wiped.');
  console.log('Reminder: ParkingSlot is now empty — re-create the parking lot layout before valets can park anyone.');
}

main()
  .catch((err) => {
    console.error('Reset failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
