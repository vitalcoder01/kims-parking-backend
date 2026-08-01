-- Self-registered accounts need an admin's sign-off before they can use the
-- app (see userService.selfRegister/approveUser); admin-created accounts are
-- already vetted at creation, so they default to approved.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "approved" BOOLEAN NOT NULL DEFAULT true;

-- Optional profile fields captured on the Vehicle Setup screen, alongside the
-- existing carNumber.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "carModel" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "carColor" TEXT;
