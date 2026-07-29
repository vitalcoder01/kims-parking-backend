// Seeds the same demo dataset the mobile app has been shipping with
// (MOCK_USERS / INITIAL_DRIVERS / INITIAL_SLOTS) so backend + frontend agree
// on demo credentials during development.
require('../src/config/env');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const USERS = [
  { employeeId: 'DOC001', name: 'Dr. Arun Kumar', username: 'Dr. Arun Kumar', role: 'doctor', department: 'Cardiology', cardCode: '472' },
  { employeeId: 'DOC002', name: 'Dr. Priya Sharma', username: 'Dr. Priya Sharma', role: 'doctor', department: 'Neurology', cardCode: '815' },
  { employeeId: 'STF001', name: 'Nurse Kavitha', username: 'Nurse Kavitha', role: 'staff', department: 'ICU', cardCode: '239' },
  { employeeId: 'STF002', name: 'Admin Suresh', username: 'Admin Suresh', role: 'staff', department: 'Reception', cardCode: '561' },
  { employeeId: 'VAL001', name: 'Ramesh', username: 'Valet Ramesh', role: 'valet' },
  { employeeId: 'VAL002', name: 'Deepa', username: 'Valet Deepa', role: 'valet' },
  { employeeId: 'DRV001', name: 'Ravi Kumar', username: 'Driver Ravi Kumar', role: 'driver', phone: '9876543210' },
  { employeeId: 'DRV002', name: 'Suresh Babu', username: 'Driver Suresh Babu', role: 'driver', phone: '9876543211' },
  { employeeId: 'DRV003', name: 'Anand Raj', username: 'Driver Anand Raj', role: 'driver', phone: '9876543212' },
  { employeeId: 'DRV004', name: 'Karthik M', username: 'Driver Karthik M', role: 'driver', phone: '9876543213' },
  { employeeId: 'DRV005', name: 'Vijay S', username: 'Driver Vijay S', role: 'driver', phone: '9876543214' },
  { employeeId: 'ADM001', name: 'Admin Manager', username: 'Admin Manager', role: 'admin' },
];

// Driver-role users get a status; Karthik starts busy, Vijay starts off duty
// to match the frontend's INITIAL_DRIVERS demo state.
const DRIVER_STATUS = {
  DRV001: 'available',
  DRV002: 'available',
  DRV003: 'available',
  DRV004: 'busy',
  DRV005: 'off',
};

const FORCE_FREE_SLOTS = new Set(['A-001', 'A-005', 'A-012', 'B-003', 'B-007', 'C-002']);

async function main() {
  const passwordHash = await bcrypt.hash('1234', 10);

  console.log('Seeding users...');
  for (const u of USERS) {
    const user = await prisma.user.upsert({
      where: { employeeId: u.employeeId },
      update: {},
      create: { ...u, password: passwordHash },
    });

    if (u.role === 'driver') {
      await prisma.driver.upsert({
        where: { userId: user.id },
        update: { status: DRIVER_STATUS[u.employeeId] },
        create: { userId: user.id, status: DRIVER_STATUS[u.employeeId] },
      });
    }
  }

  console.log('Seeding parking slots (3 blocks x 30)...');
  const blocks = ['A', 'B', 'C'];
  const slotData = [];
  for (const block of blocks) {
    for (let i = 1; i <= 30; i++) {
      const id = `${block}-${String(i).padStart(3, '0')}`;
      const forceFree = FORCE_FREE_SLOTS.has(id);
      slotData.push({
        id,
        block,
        number: i,
        status: forceFree ? 'free' : (Math.random() > 0.4 ? 'occupied' : 'free'),
      });
    }
  }
  for (const s of slotData) {
    await prisma.parkingSlot.upsert({ where: { id: s.id }, update: {}, create: s });
  }

  console.log('Seed complete.');
  console.log('Demo login: any loginName above with password "1234" (e.g. "Dr. Arun Kumar" / 1234, "Valet Ramesh" / 1234, "Driver Ravi Kumar" / 1234, "Admin Manager" / 1234).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
