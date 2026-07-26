// Tiny in-process cache for the handful of GET queries every connected
// client polls every ~4s (tasks/slots/drivers/visitors). These are not
// per-user — every client asking "what are all the active tasks" gets the
// same answer — so instead of hitting Postgres once per client per poll,
// the first request in a short window populates the cache and every other
// concurrent poller is served from memory. A write anywhere that could
// affect these lists invalidates immediately, so this never serves stale
// data beyond the (short) TTL — it just deduplicates identical reads.
const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.data;
}

function set(key, data, ttlMs) {
  store.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// Drops every cached entry whose key starts with `prefix` — call this from
// any mutation that could change what a cached list query would return.
function invalidate(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

// Wraps `compute` with cache get/set for `key`, so call sites read as a
// single expression instead of repeating the get-or-compute-then-set dance.
async function cached(key, ttlMs, compute) {
  const hit = get(key);
  if (hit !== undefined) return hit;
  const data = await compute();
  set(key, data, ttlMs);
  return data;
}

module.exports = { get, set, invalidate, cached };
