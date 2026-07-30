const prisma = require('../config/database');

// Operational knobs the admin can tune at runtime. Every key gets a default
// here so the app behaves sanely on a fresh database with no settings rows.
const DEFAULTS = {
  // Seconds a driver has to accept an assignment before the valet is
  // prompted to reassign ("1 min, changeable by admin").
  driverAcceptTimeoutSeconds: '60',
  // The parking lot itself, as one fixed point the admin drops on a map
  // once — a park task's real "destination" never moves and isn't known
  // per-task (unlike a retrieval, whose destination is wherever the doctor
  // is standing right now), so there's nothing to derive it from per job.
  // Empty string means "not set yet" — park tasks then just have no
  // destination, same as before this existed.
  parkingLotLat: '',
  parkingLotLng: '',
};

const CACHE_TTL_MS = 5000;
let cacheAt = 0;
let cached = null;

async function getAll() {
  if (cached && Date.now() - cacheAt < CACHE_TTL_MS) return cached;
  const rows = await prisma.setting.findMany();
  const merged = { ...DEFAULTS };
  for (const row of rows) merged[row.key] = row.value;
  cached = merged;
  cacheAt = Date.now();
  return merged;
}

async function get(key) {
  const all = await getAll();
  return all[key];
}

async function getAcceptTimeoutMs() {
  const raw = Number(await get('driverAcceptTimeoutSeconds'));
  const seconds = Number.isFinite(raw) && raw >= 10 ? raw : 60;
  return seconds * 1000;
}

async function getParkingLotDestination() {
  const all = await getAll();
  const lat = Number(all.parkingLotLat);
  const lng = Number(all.parkingLotLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !all.parkingLotLat || !all.parkingLotLng) return null;
  return { lat, lng };
}

async function update(patch) {
  const keys = Object.keys(patch).filter(k => k in DEFAULTS);
  for (const key of keys) {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: String(patch[key]) },
      update: { value: String(patch[key]) },
    });
  }
  cached = null;
  return getAll();
}

module.exports = { getAll, get, getAcceptTimeoutMs, getParkingLotDestination, update, DEFAULTS };
