const bcrypt = require('bcryptjs');
const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');

// Used by the valet "Collect Key" flow to identify a doctor/staff member by
// the 3-digit code shown on their virtual valet card.
async function findByCardCode(cardCode) {
  const user = await prisma.user.findFirst({
    where: {
      cardCode,
      role: { in: ['doctor', 'staff'] },
    },
  });
  if (!user) throw ApiError.notFound('No doctor/staff found with this code');
  return user;
}

// Admin: staff directory — includes each user's driver profile (if any) so
// the admin UI can show driver status without a second round-trip.
async function listUsers() {
  return prisma.user.findMany({
    include: { driver: true },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });
}

// Admin: "Add Staff" — creates a login for any role. Driver-role accounts
// also get their linked Driver row created in the same transaction, exactly
// like the seed script does, so a new driver login is immediately assignable
// to tasks without a separate manual step.
async function createUser({ employeeId, name, role, password, department, cardCode, phone, carNumber }) {
  const id = employeeId.trim().toUpperCase();

  const existing = await prisma.user.findUnique({ where: { employeeId: id } });
  if (existing) throw ApiError.conflict(`Employee ID ${id} is already in use`);

  if (cardCode) {
    const codeTaken = await prisma.user.findUnique({ where: { cardCode } });
    if (codeTaken) throw ApiError.conflict(`Card code ${cardCode} is already in use`);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        employeeId: id,
        password: passwordHash,
        name: name.trim(),
        role,
        department: department?.trim() || null,
        cardCode: cardCode || null,
        phone: phone?.trim() || null,
        carNumber: carNumber?.trim().toUpperCase() || null,
      },
    });

    if (role === 'driver') {
      await tx.driver.create({ data: { userId: user.id, status: 'available' } });
    }

    return tx.user.findUnique({ where: { id: user.id }, include: { driver: true } });
  });
}

module.exports = { findByCardCode, listUsers, createUser };
