const bcrypt = require('bcryptjs');
const prisma = require('../config/database');
const { signToken } = require('../utils/jwt');
const ApiError = require('../utils/ApiError');

async function login(loginName, password) {
  const trimmed = loginName.trim();
  // Case-insensitive on username — nobody should get locked out over "dr."
  // vs "Dr.". Self-registered accounts can also log in with the phone
  // number they signed up with (stored as employeeId) — they may not
  // remember exactly how they capitalized/typed their name.
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { username: { equals: trimmed, mode: 'insensitive' } },
        { employeeId: { equals: trimmed, mode: 'insensitive' } },
      ],
    },
    include: { driver: true },
  });
  if (!user) throw ApiError.unauthorized('Invalid login name or password');

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) throw ApiError.unauthorized('Invalid login name or password');

  const token = signToken({ sub: user.id, role: user.role });
  return { token, user };
}

async function me(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { driver: true },
  });
  if (!user) throw ApiError.notFound('User not found');
  return user;
}

module.exports = { login, me };
