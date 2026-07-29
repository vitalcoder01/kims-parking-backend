// Route params and JSON bodies always arrive as strings, but most primary
// keys in this schema are Postgres integers (autoincrement) — only a few
// (ParkingSlot.id, Setting.key, Visitor.publicToken) are genuinely
// non-numeric strings. Converting only when the value actually looks
// numeric makes this safe to apply everywhere without needing to know
// which kind of id a given field is: "4" -> 4, but "A-001" or a cuid
// token pass through untouched.
function parseId(value) {
  if (value === undefined || value === null || value === '') return value;
  if (typeof value === 'number') return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

module.exports = parseId;
