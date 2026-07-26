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
    assignedAt: task.assignedAt,
    keyCollectedAt: task.keyCollectedAt,
    completedAt: task.completedAt,
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
    carNumber: v.carNumber,
    mobile: v.mobile,
    slotId: v.slotId ?? undefined,
    driverName: v.driverName ?? undefined,
    status: v.status,
    token: v.token,
    trackingProgress: v.trackingProgress ?? undefined,
    createdAt: v.createdAt,
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
  serializeNotification,
};
