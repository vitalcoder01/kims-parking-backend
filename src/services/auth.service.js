const bcrypt = require('bcryptjs');
const prisma = require('../config/database');
const { signToken } = require('../utils/jwt');
const ApiError = require('../utils/ApiError');

async function login(loginName, password) {
  // Case-insensitive — nobody should get locked out over "dr." vs "Dr.".
  const user = await prisma.user.findFirst({
    where: { username: { equals: loginName.trim(), mode: 'insensitive' } },
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
