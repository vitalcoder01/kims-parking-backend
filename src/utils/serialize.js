function serializeUser(user) {
  if (!user) return null;
  const { password, driver, ...rest } = user;
  return {
    ...rest,
    linkedDriverId: driver ? driver.id : undefined,
    driverStatus: driver ? driver.status : undefined,
  };
}

function serializeTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    type: task.type,
    doctorId: task.doctorId,
    doctorName: task.doctor?.name,
    carNumber: task.carNumber,
    slotId: task.slotId ?? undefined,
    driverId: task.driverId ?? undefined,
    driverName: task.driver?.user?.name,
    valetId: task.valetId ?? undefined,
    valetName: task.valet?.name,
    escalatedAt: task.escalatedAt ?? undefined,
    status: task.status,
    requestedAt: task.requestedAt ?? undefined,
    assignedAt: task.assignedAt,
    keyCollectedAt: task.keyCollectedAt,
    completedAt: task.completedAt,
    acceptedAt: task.acceptedAt ?? undefined,
    startedAt: task.startedAt ?? undefined,
    recalledAt: task.recalledAt ?? undefined,
    // Planned departure, not an ETA — see ParkingTask in schema.prisma.
    plannedDepartureMinutes: task.plannedDepartureMinutes ?? undefined,
    trackingProgress: task.trackingProgress ?? undefined,
    driverLat: task.driverLat ?? undefined,
    driverLng: task.driverLng ?? undefined,
    locationUpdatedAt: task.locationUpdatedAt ?? undefined,
    driverStartLat: task.driverStartLat ?? undefined,
    driverStartLng: task.driverStartLng ?? undefined,
    destinationLat: task.destinationLat ?? undefined,
    destinationLng: task.destinationLng ?? undefined,
  };
}

function serializeSlot(slot) {
  if (!slot) return null;
  return {
    id: slot.id,
    block: slot.block,
    number: slot.number,
    status: slot.status,
    carNumber: slot.carNumber ?? undefined,
    doctorId: slot.doctorId ?? undefined,
    taskId: slot.taskId ?? undefined,
  };
}

function serializeDriver(driver) {
  if (!driver) return null;
  return {
    id: driver.id,
    name: driver.user?.name,
    phone: driver.user?.phone,
    status: driver.status,
    currentTaskId: driver.currentTaskId ?? undefined,
  };
}

function serializeVisitor(v) {
  if (!v) return null;
  return {
    id: v.id,
    name: v.name,
    carNumber: v.carNumber || undefined, // '' means "no plate captured yet"
    mobile: v.mobile,
    vehicleType: v.vehicleType ?? 'car',
    slotId: v.slotId ?? undefined,
    driverId: v.driverId ?? undefined,
    driverName: v.driver?.user?.name ?? v.driverName ?? undefined,
    valetId: v.valetId ?? undefined,
    escalatedAt: v.escalatedAt ?? undefined,
    status: v.status,
    retrievalRequested: v.retrievalRequested,
    driverAssignedAt: v.driverAssignedAt ?? undefined,
    acceptedAt: v.acceptedAt ?? undefined,
    pickedUpAt: v.pickedUpAt ?? undefined,
    cancelledAt: v.cancelledAt ?? undefined,
    cancelReason: v.cancelReason ?? undefined,
    token: v.token,
    publicToken: v.publicToken,
    trackingProgress: v.trackingProgress ?? undefined,
    createdAt: v.createdAt,
  };
}

// Public tracking page — deliberately excludes mobile number and token;
// this is reachable by anyone with the link, not just the visitor.
function serializeVisitorPublic(v) {
  if (!v) return null;
  return {
    name: v.name,
    carNumber: v.carNumber || undefined,
    vehicleType: v.vehicleType ?? 'car',
    slotId: v.slotId ?? undefined,
    driverName: v.driver?.user?.name ?? v.driverName ?? undefined,
    status: v.status,
    retrievalRequested: v.retrievalRequested,
    trackingProgress: v.trackingProgress ?? undefined,
    createdAt: v.createdAt,
  };
}

function serializeArrivalNotice(n) {
  if (!n) return null;
  return {
    id: n.id,
    doctorId: n.doctorId,
    doctorName: n.doctor?.name,
    // Lets the valet skip straight to driver assignment from this card
    // (no code entry) when the plate's already on file — same "already
    // known, don't ask again" rule the code-scan flow itself follows.
    doctorCarNumber: n.doctor?.carNumber ?? undefined,
    // Only needed for the "no plate on file yet" fallback screen (Path B
    // skips the code lookup, so this is the only place left to get them).
    doctorDepartment: n.doctor?.department ?? undefined,
    doctorEmployeeId: n.doctor?.employeeId ?? undefined,
    eta: n.eta,
    createdAt: n.createdAt,
  };
}

function serializeNotification(n) {
  if (!n) return null;
  return {
    id: n.id,
    targetRole: n.targetRole,
    targetId: n.targetUserId ?? undefined,
    title: n.title,
    body: n.body,
    type: n.type,
    read: n.read,
    createdAt: n.createdAt,
  };
}

module.exports = {
  serializeUser,
  serializeTask,
  serializeSlot,
  serializeDriver,
  serializeVisitor,
  serializeVisitorPublic,
  serializeNotification,
  serializeArrivalNotice,
};
