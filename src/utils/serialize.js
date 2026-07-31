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
    doctorId: task.doctorId ?? undefined,
    // One label for "whose car is this", whether the owner is a staff member
    // or a visitor. The valet's queue and inbox render this field and should
    // not have to know which kind of session they are looking at.
    // Trim-then-|| , not ??: a visitor may check in with NO name (it is
    // optional), and '' passes straight through ?? — which rendered the
    // driver's card as "AP 04 AR 2343 · " with nothing after the separator.
    doctorName: (task.doctor?.name ?? task.visitor?.name ?? '').trim()
      || (task.visitorId != null ? 'Visitor' : undefined),
    visitorId: task.visitorId ?? undefined,
    // Lets the UI say "Visitor" where it matters (e.g. no department to show)
    // without inferring it from a missing doctorId.
    isVisitor: task.visitorId != null ? true : undefined,
    // Who this person actually is, for the valet about to dispatch someone on
    // their behalf. Same two fields the arrival notice already exposes, so
    // this widens no privacy surface — deliberately NOT the phone number,
    // which serializeTask would hand to every driver as well.
    doctorDepartment: task.doctor?.department ?? undefined,
    doctorEmployeeId: task.doctor?.employeeId ?? undefined,
    carNumber: task.carNumber,
    slotId: task.slotId ?? undefined,
    driverId: task.driverId ?? undefined,
    driverName: task.driver?.user?.name,
    valetId: task.valetId ?? undefined,
    valetName: task.valet?.name,
    escalatedAt: task.escalatedAt ?? undefined,
    // Session ownership. arrivalOwner is written once and never overwritten —
    // it's the audit trail of who took the car in. retrievalOwner is separate
    // so a recovery hand-off doesn't erase that history.
    arrivalOwnerValetId: task.arrivalOwnerValetId ?? undefined,
    arrivalOwnerValetName: task.arrivalOwnerValet?.name,
    arrivalAcceptedAt: task.arrivalAcceptedAt ?? undefined,
    retrievalOwnerValetId: task.retrievalOwnerValetId ?? undefined,
    retrievalOwnerValetName: task.retrievalOwnerValet?.name,
    retrievalAcceptedAt: task.retrievalAcceptedAt ?? undefined,
    retrievalOwnershipSource: task.retrievalOwnershipSource ?? undefined,
    ownerNotifiedAt: task.ownerNotifiedAt ?? undefined,
    // Set when the owner's response window lapsed and the request went back
    // out to everyone — the frontend shows the "Original owner unavailable"
    // reason off this.
    recoveryBroadcastAt: task.recoveryBroadcastAt ?? undefined,
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
    // Absolute departure time, and the moment the request becomes actionable
    // (departure minus the configured lead time). Sent so the app can render
    // SCHEDULED vs READY without knowing the lead-time setting, and without
    // recomputing a deadline the server already fixed.
    plannedDepartureAt: task.plannedDepartureAt ?? undefined,
    retrievalReadyAt: task.retrievalReadyAt ?? undefined,
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
    // Jobs finished today. Undefined rather than 0 when it wasn't computed
    // (single-driver lookups don't run the grouped query), so the UI can tell
    // "none yet" from "not known" instead of asserting a zero it can't back up.
    completedToday: driver.completedToday,
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
    // The parking token belongs on the tracking page — it is what the visitor
    // shows at the desk to collect their car, and the page is now the primary
    // place they read it when WhatsApp is switched off.
    token: v.token,
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
    // The 3-digit valet code. This is what a doctor reads out at the counter,
    // so it's the primary thing the valet searches this list by once it's
    // long enough to need searching. Valets already look people up by it.
    doctorCardCode: n.doctor?.cardCode ?? undefined,
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
