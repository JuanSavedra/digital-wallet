-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "wallet_deposits" (
    "id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'abacatepay',
    "provider_charge_id" TEXT NOT NULL,
    "provider_product_id" TEXT,
    "checkout_url" TEXT NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "wallet_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_deposits_provider_charge_id_key" ON "wallet_deposits"("provider_charge_id");

-- CreateIndex
CREATE INDEX "wallet_deposits_wallet_id_idx" ON "wallet_deposits"("wallet_id");

-- AddForeignKey
ALTER TABLE "wallet_deposits" ADD CONSTRAINT "wallet_deposits_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint
ALTER TABLE "wallet_deposits" ADD CONSTRAINT "wallet_deposits_amount_positive" CHECK ("amount" > 0);
