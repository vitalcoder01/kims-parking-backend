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
    status: task.status,
    requestedAt: task.requestedAt ?? undefined,
    assignedAt: task.assignedAt,
    keyCollectedAt: task.keyCollectedAt,
    completedAt: task.completedAt,
    acceptedAt: task.acceptedAt ?? undefined,
    eta: task.eta ?? undefined,
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
