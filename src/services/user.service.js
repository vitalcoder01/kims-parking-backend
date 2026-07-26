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

module.exports = { findByCardCode };
