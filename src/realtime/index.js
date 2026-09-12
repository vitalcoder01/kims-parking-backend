// True-WebSocket realtime layer. Every mutating service emits the *changed
// data itself* through here, so connected apps patch exactly that entity in
// place — no client ever refetches a list because "something changed".
//
// Module is a singleton: services require it directly and call the emit
// helpers; before initRealtime() runs (or in tests) every emit is a no-op.
const { Server } = require('socket.io');
const { verifyToken } = require('../utils/jwt');
const prisma = require('../config/database');
const { CORS_ORIGIN } = require('../config/env');

let io = null;

// driverId -> number of live sockets. A driver whose app is fully killed
// drops to 0 and disappears from the valet map (presence, not persistence).
const driverSockets = new Map();

function onlineDriverIds() {
  return [...driverSockets.keys()];
}

// A connected valet's station is read once, at handshake time, and cached
// on socket.data.user for that connection's whole life (see io.use below).
// An admin reassigning them mid-session used to change nothing about an
// already-open tab: the socket had already joined (or not) the
// role:valetStation:<x> room based on the OLD value, and nothing ever
// revisited that decision short of a full reconnect — so a freshly
// assigned lot valet, still on the tab they were already using, silently
// received none of the retrieval alerts routed to their new station.
// Called from user.service.js's updateUser whenever valetStation actually
// changes, right alongside the existing auth-cache invalidation, so a
// station reassignment applies to a live session exactly like a role
// change already did.
function refreshValetStationRooms(userId, newStation) {
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.user?.id !== userId) continue;
    const oldStation = socket.data.user.valetStation;
    if (oldStation === newStation) continue;
    if (oldStation) socket.leave(`role:valetStation:${oldStation}`);
    if (newStation) socket.join(`role:valetStation:${newStation}`);
    socket.data.user.valetStation = newStation;
  }
}

function initRealtime(server) {
  io = new Server(server, {
    path: '/socket.io',
    cors: { origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map(o => o.trim()) },
    // Phones on hospital wifi/cellular drop silently; aggressive pings make
    // "app killed" reflect on the valet map within ~30s instead of minutes.
    pingInterval: 10000,
    pingTimeout: 15000,
  });

  // Same JWT the REST API uses — sent as `auth.token` on connection.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('missing token'));
      const payload = verifyToken(token);
      const user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { driver: true } });
      if (!user) return next(new Error('user no longer exists'));
      socket.data.user = { id: user.id, role: user.role, name: user.name, driverId: user.driver?.id ?? null, valetStation: user.valetStation ?? null };
      next();
    } catch {
      next(new Error('invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { id, role, name, driverId, valetStation } = socket.data.user;
    socket.join(`role:${role}`);
    socket.join(`user:${id}`);
    // Two-station handoff model (see task.service.js gateHandoff /
    // confirmParkedByValet): a valet assigned to a physical station also
    // joins that station's room, so a retrieval alert or a 'no drivers on
    // my side' handback can reach exactly the gate valets or exactly the
    // lot valets instead of every valet on shift. Reuses the existing
    // 'role:<name>' room convention (emitToRoles/notification targetRole
    // both already know how to address 'role:<anything>') rather than
    // adding a second addressing scheme.
    if (role === 'valet' && valetStation) socket.join(`role:valetStation:${valetStation}`);
    if (driverId) {
      socket.join(`driver:${driverId}`);
      const count = (driverSockets.get(driverId) ?? 0) + 1;
      driverSockets.set(driverId, count);
      if (count === 1) {
        io.to('role:valet').to('role:admin').emit('presence:driver', { driverId, online: true });
      }
    }

    // Ops screens get the current picture of who is reachable right away,
    // so the map never shows markers for phones that are already gone.
    if (role === 'valet' || role === 'admin') {
      socket.emit('presence:snapshot', { driverIds: onlineDriverIds() });
    }

    // Continuous driver GPS (on task or idle) — relayed straight to the ops
    // screens, never touching the DB. Task-leg positions additionally go
    // through PATCH /tasks/:id/location which persists + emits task:upsert.
    socket.on('driver:location', (pos) => {
      if (!driverId) return;
      const lat = Number(pos?.lat); const lng = Number(pos?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      io.to('role:valet').to('role:admin').emit('driver:location', {
        driverId, name, lat, lng, at: Date.now(),
      });
    });

    socket.on('disconnect', () => {
      if (!driverId) return;
      const count = (driverSockets.get(driverId) ?? 1) - 1;
      if (count <= 0) {
        driverSockets.delete(driverId);
        io.to('role:valet').to('role:admin').emit('presence:driver', { driverId, online: false });
      } else {
        driverSockets.set(driverId, count);
      }
    });
  });

  return io;
}

// ── emit helpers (all safe no-ops before init) ──────────────────────────
// Entity deltas broadcast to every authenticated client — the same audience
// the REST list endpoints already serve to every role.
function emitAll(event, payload) {
  if (io) io.emit(event, payload);
}

function emitToRoles(roles, event, payload) {
  if (!io) return;
  let chain = io;
  for (const role of roles) chain = chain.to(`role:${role}`);
  chain.emit(event, payload);
}

function emitToUser(userId, event, payload) {
  if (io) io.to(`user:${userId}`).emit(event, payload);
}

function emitToDriver(driverId, event, payload) {
  if (io) io.to(`driver:${driverId}`).emit(event, payload);
}

module.exports = {
  initRealtime,
  emitAll,
  emitToRoles,
  emitToUser,
  emitToDriver,
  onlineDriverIds,
  refreshValetStationRooms,
};
