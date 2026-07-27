-- AlterTable
ALTER TABLE "users" ADD COLUMN "loginName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_loginName_key" ON "users"("loginName");
