const bcrypt = require('bcryptjs');
const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');
const { invalidateUserCache } = require('../middleware/auth.middleware');
const cache = require('../utils/responseCache');
const realtime = require('../realtime');
const { serializeTask } = require('../utils/serialize');
const { signToken } = require('../utils/jwt');

// What staff actually type to log in — no employee codes to remember. Admin
// accounts are exempt (their `name` IS the literal login, e.g. "Admin1") since
// they're master-control logins, not people wearing a role badge.
const LOGIN_PREFIX = { doctor: 'Dr. ', staff: '', valet: 'Valet ', driver: 'Driver ', admin: '' };

async function generateUniqueLoginName(tx, role, name, excludeUserId) {
  const base = `${LOGIN_PREFIX[role] ?? ''}${name.trim()}`.trim();
  let candidate = base;
  let n = 2;
  // Case-insensitive so "Dr. Aditya" and "dr. aditya" can't collide, and
  // Postgres text uniqueness is case-sensitive by default.
  while (await tx.user.findFirst({
    where: { username: { equals: candidate, mode: 'insensitive' }, ...(excludeUserId && { id: { not: excludeUserId } }) },
  })) {
    candidate = `${base} ${n}`;
    n += 1;
  }
  return candidate;
}

// Self-registered accounts log in as exactly what they typed — "aditya"
// stays "aditya" forever, never gains a "Dr."/"Staff" prefix the way
// admin-created accounts do, regardless of which role they end up as. Same
// disambiguation on a collision ("aditya 2"), just no LOGIN_PREFIX applied.
async function generateUniqueRawLoginName(tx, name, excludeUserId) {
  const base = name.trim();
  let candidate = base;
  let n = 2;
  while (await tx.user.findFirst({
    where: { username: { equals: candidate, mode: 'insensitive' }, ...(excludeUserId && { id: { not: excludeUserId } }) },
  })) {
    candidate = `${base} ${n}`;
    n += 1;
  }
  return candidate;
}

// A self-registered account has no admin-assigned valet card code to type
// in, so one is picked automatically — same 3-digit format, same uniqueness
// rule as an admin-assigned one, just generated instead of typed. Retries
// on a collision rather than failing outright; the code space (000-999) is
// large enough relative to headcount that this converges in one or two
// tries almost always.
async function generateUniqueCardCode(tx) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    const taken = await tx.user.findUnique({ where: { cardCode: candidate } });
    if (!taken) return candidate;
  }
  // Practically unreachable (1000 codes vs. a hospital's actual headcount),
  // but a real error here beats an infinite loop or a silently null code.
  throw ApiError.conflict('Could not generate a card code — please try again');
}

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
    const username = await generateUniqueLoginName(tx, role, name);
    const user = await tx.user.create({
      data: {
        employeeId: id,
        username,
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

// Admin: edit an existing account's profile fields and/or role. A role
// change into/out of 'driver' creates/removes the linked Driver row so the
// account is immediately consistent — e.g. "transferring" a staff member to
// a driver role makes them assignable to tasks right away, and moving a
// driver to another role cleanly drops their driver profile instead of
// leaving an orphaned one behind.
async function updateUser(id, { name, role, department, cardCode, phone, carNumber }) {
  const existing = await prisma.user.findUnique({ where: { id }, include: { driver: true } });
  if (!existing) throw ApiError.notFound('User not found');

  if (cardCode && cardCode !== existing.cardCode) {
    const codeTaken = await prisma.user.findUnique({ where: { cardCode } });
    if (codeTaken) throw ApiError.conflict(`Card code ${cardCode} is already in use`);
  }

  return prisma.$transaction(async (tx) => {
    const nameChanged = name !== undefined && name.trim() !== existing.name;
    const roleChanged = role !== undefined && role !== existing.role;
    const username = (nameChanged || roleChanged)
      ? await generateUniqueLoginName(tx, role ?? existing.role, name ?? existing.name, id)
      : undefined;

    await tx.user.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(role !== undefined && { role }),
        ...(username !== undefined && { username }),
        ...(department !== undefined && { department: department?.trim() || null }),
        ...(cardCode !== undefined && { cardCode: cardCode || null }),
        ...(phone !== undefined && { phone: phone?.trim() || null }),
        ...(carNumber !== undefined && { carNumber: carNumber?.trim().toUpperCase() || null }),
      },
    });

    if (role !== undefined && role !== existing.role) {
      if (role === 'driver' && !existing.driver) {
        await tx.driver.create({ data: { userId: id, status: 'available' } });
      } else if (role !== 'driver' && existing.driver) {
        // A driver with any task history (i.e. any real driver after their
        // first day) can't have their Driver row deleted — ParkingTask.driverId
        // references it with no cascade, by design, so history is never lost.
        // Leave the row in place rather than failing the whole edit over it;
        // it's harmless once the account's role is no longer 'driver' (it
        // stops showing up as a driver anywhere and is never assignable again).
        await tx.driver.delete({ where: { userId: id } }).catch(async (err) => {
          if (err.code !== 'P2003') throw err;
          // Can't delete — force it inert (off duty, unassigned) so it can
          // never be picked for a new task; listDrivers also filters on the
          // linked user's current role as a second guard against this.
          await tx.driver.update({ where: { userId: id }, data: { status: 'off', currentTaskId: null } });
        });
      }
    }

    const updated = await tx.user.findUnique({ where: { id }, include: { driver: true } });
    invalidateUserCache(id);
    return updated;
  });
}

// Admin: reset an account's password (e.g. after a staff member forgets it).
async function resetPassword(id, newPassword) {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('User not found');

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id }, data: { password: passwordHash } });
  invalidateUserCache(id);
}

// Admin: remove an account entirely. Driver profile and attendance history
// cascade automatically (schema onDelete: Cascade). Task history does NOT
// cascade — a doctor/staff/driver with any park/retrieve tasks on record
// can't be deleted, by design, so that real history is never silently
// destroyed by removing an account; the error here explains that instead of
// leaking the raw database constraint failure.
async function deleteUser(id) {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('User not found');

  try {
    await prisma.user.delete({ where: { id } });
    invalidateUserCache(id);
  } catch (err) {
    if (err.code === 'P2003') {
      throw ApiError.conflict(
        `Cannot delete ${existing.name} — they have parking task history on record. Consider this a permanent record; if they've left, changing their role or leaving the account inactive is safer than deleting it.`,
      );
    }
    throw err;
  }
}

// Self-service — a user updating their own car number/phone, not an admin
// editing someone else's account (see updateUser for that, admin-only).
async function updateOwnProfile(id, { carNumber, phone }) {
  const updated = await prisma.user.update({
    where: { id },
    data: {
      ...(carNumber !== undefined && { carNumber: carNumber?.trim().toUpperCase() || null }),
      ...(phone !== undefined && { phone: phone?.trim() || null }),
    },
    include: { driver: true },
  });
  invalidateUserCache(id);

  // A parking task's carNumber is captured at creation time (the valet may
  // have typed a different plate than whatever's on file) — but once this
  // person edits their own profile plate, any task of theirs still in
  // progress should track it too, or the "current session" card would keep
  // showing a now-stale number with no way to fix it short of the valet
  // recreating the task.
  if (carNumber !== undefined && updated.carNumber) {
    const activeTasks = await prisma.parkingTask.findMany({
      where: { doctorId: id, status: { not: 'completed' } },
    });
    for (const task of activeTasks) {
      const patched = await prisma.parkingTask.update({
        where: { id: task.id },
        data: { carNumber: updated.carNumber },
        include: { doctor: true, visitor: true, driver: { include: { user: true } } },
      });
      realtime.emitAll('task:upsert', serializeTask(patched));
    }
    if (activeTasks.length) cache.invalidate('tasks:');
  }

  return updated;
}

// Public, unauthenticated — a doctor/staff member creating their own login
// instead of an admin typing it in for them. Deliberately minimal: name,
// phone, password, nothing else required.
//
// The phone number doubles as `employeeId` — the column that already
// enforces "one account per real identity" for admin-created accounts. This
// reuses that exact constraint instead of adding a new one: no schema
// change, and a duplicate signup attempt fails with the same clear
// "already in use" conflict admin's own form already produces.
//
// Role defaults to 'doctor' immediately (not left null/pending) so the
// account is fully usable the instant it's created — see
// updateOwnDesignation for the follow-up screen that lets them correct it
// to 'staff' if that's what they actually are. Card code is generated here
// too, not left for an admin to fill in later, so the valet counter can
// recognize them from the very first day.
async function selfRegister({ name, phone, password }) {
  const trimmedName = (name ?? '').trim();
  const digits = (phone ?? '').replace(/\D/g, '');
  if (!trimmedName) throw ApiError.badRequest('Name is required');
  if (digits.length !== 10) throw ApiError.badRequest('Enter a valid 10-digit phone number');
  if (!password || password.length < 8 || password.length > 64) {
    throw ApiError.badRequest('Password must be 8–64 characters');
  }

  const existing = await prisma.user.findUnique({ where: { employeeId: digits } });
  if (existing) {
    throw ApiError.conflict('This phone number is already registered — log in instead');
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.$transaction(async (tx) => {
    const username = await generateUniqueRawLoginName(tx, trimmedName);
    const cardCode = await generateUniqueCardCode(tx);
    return tx.user.create({
      data: {
        employeeId: digits,
        username,
        password: passwordHash,
        name: trimmedName,
        role: 'doctor',
        phone: digits,
        cardCode,
      },
    });
  });

  const token = signToken({ sub: user.id, role: user.role });
  return { token, user };
}

// The one-time (though not enforced as such — see below) follow-up to
// selfRegister: correcting the default 'doctor' role to 'staff' if that's
// what they actually are. Deliberately NOT a general "change my role"
// endpoint — doctor and staff carry identical permissions everywhere in
// this app (same screens, same actions), so toggling between only these
// two is safe to leave open-ended rather than tracking whether it's
// already been set once. It can never be used to reach valet/driver/admin.
async function updateOwnDesignation(id, role) {
  if (role !== 'doctor' && role !== 'staff') {
    throw ApiError.badRequest('Designation must be doctor or staff');
  }
  const updated = await prisma.user.update({ where: { id }, data: { role }, include: { driver: true } });
  invalidateUserCache(id);
  return updated;
}

module.exports = { findByCardCode, listUsers, createUser, updateUser, resetPassword, deleteUser, updateOwnProfile, selfRegister, updateOwnDesignation };
