-- Escopo 13 (Segurança) — auditoria do livro-razão.
--
-- Dois problemas resolvidos aqui:
--
-- 1. Depósitos creditavam `wallets.balance` direto, sem lançamento no
--    ledger. Isso quebrava o invariante que justifica o ledger existir:
--    `saldo == soma dos lançamentos`. Numa auditoria, um saldo maior que a
--    soma do razão é indistinguível de crédito fraudulento.
--
-- 2. Nada impedia UPDATE/DELETE em `transaction_entries`. "Append-only" era
--    só uma convenção no comentário do schema — qualquer bug, migration ou
--    acesso direto ao banco reescrevia o histórico financeiro sem deixar
--    rastro.

-- --- 1. Lançamentos de depósito -------------------------------------------

-- `transaction_id` deixa de ser obrigatório: um lançamento agora vem de uma
-- transferência OU de um depósito.
ALTER TABLE "transaction_entries" ALTER COLUMN "transaction_id" DROP NOT NULL;

ALTER TABLE "transaction_entries" ADD COLUMN "deposit_id" TEXT;

ALTER TABLE "transaction_entries"
  ADD CONSTRAINT "transaction_entries_deposit_id_fkey"
  FOREIGN KEY ("deposit_id") REFERENCES "wallet_deposits"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "transaction_entries_deposit_id_idx"
  ON "transaction_entries"("deposit_id");

-- Exatamente uma origem por lançamento: nem órfão (nenhuma das duas), nem
-- ambíguo (as duas). `<>` sobre booleanos é XOR.
ALTER TABLE "transaction_entries"
  ADD CONSTRAINT "transaction_entries_source_exactly_one"
  CHECK (("transaction_id" IS NULL) <> ("deposit_id" IS NULL));

-- Backfill dos depósitos já pagos antes desta migration, para que o
-- invariante saldo == soma(ledger) passe a valer também para o histórico.
INSERT INTO "transaction_entries" ("id", "wallet_id", "deposit_id", "direction", "amount", "created_at")
SELECT
  gen_random_uuid()::text,
  d."wallet_id",
  d."id",
  'CREDIT',
  d."amount",
  COALESCE(d."paid_at", d."created_at")
FROM "wallet_deposits" d
WHERE d."status" = 'PAID'
  AND NOT EXISTS (
    SELECT 1 FROM "transaction_entries" e WHERE e."deposit_id" = d."id"
  );

-- --- 2. Ledger append-only ------------------------------------------------

-- A flag de sessão `app.ledger_maintenance` é a única saída, e existe para
-- a limpeza dos testes e2e (que precisam remover as linhas que criaram).
-- Como só pode ser ligada por quem já tem acesso direto ao banco, e nunca é
-- ligada pelo código da aplicação, o caminho normal continua sem exceção.
CREATE OR REPLACE FUNCTION "transaction_entries_append_only"()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.ledger_maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'transaction_entries e append-only: % nao e permitido (livro-razao imutavel)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "transaction_entries_no_update"
  BEFORE UPDATE ON "transaction_entries"
  FOR EACH ROW EXECUTE FUNCTION "transaction_entries_append_only"();

CREATE TRIGGER "transaction_entries_no_delete"
  BEFORE DELETE ON "transaction_entries"
  FOR EACH ROW EXECUTE FUNCTION "transaction_entries_append_only"();
