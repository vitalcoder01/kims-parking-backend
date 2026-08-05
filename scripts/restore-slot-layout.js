// One-off: restores the parking lot layout (3 blocks x 30 slots, IDs
// A-001..A-030 / B-001..B-030 / C-001..C-030) that reset-data.js wiped
// along with all other transactional data. All slots come back 'free'
// since nothing is actually parked right now. Does NOT touch Users,
// Drivers, or Settings.
require('../src/config/env');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const blocks = ['A', 'B', 'C'];
  const slotData = [];
  for (const block of blocks) {
    for (let i = 1; i <= 30; i++) {
      slotData.push({
        id: `${block}-${String(i).padStart(3, '0')}`,
        block,
        number: i,
        status: 'free',
      });
    }
  }

  console.log(`Restoring ${slotData.length} parking slots (3 blocks x 30)...`);
  for (const s of slotData) {
    await prisma.parkingSlot.upsert({ where: { id: s.id }, update: {}, create: s });
  }
  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
