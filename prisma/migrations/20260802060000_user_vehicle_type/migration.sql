-- The doctor/staff member's own vehicle type (car/bike), for the Vehicle
-- Setup screen — separate from Visitor.vehicleType (a different person's
-- car). Nullable, no default: an existing account with a car number on file
-- shouldn't silently become "car" via migration when nobody actually chose
-- that.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "vehicleType" "VehicleType";
