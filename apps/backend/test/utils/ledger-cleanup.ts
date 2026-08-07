import type { Prisma, PrismaClient } from '@prisma/client';

/** Aceita tanto o `PrismaService` do Nest quanto um `PrismaClient` cru —
 * as suítes e2e usam os dois. */
type PrismaLike = Pick<PrismaClient, '$transaction'>;

/**
 * `transaction_entries` é append-only no banco: triggers `BEFORE UPDATE` e
 * `BEFORE DELETE` rejeitam qualquer alteração (migration
 * `add_ledger_deposits_and_append_only`). A limpeza dos testes precisa
 * remover as linhas que criou, então liga a única escotilha prevista — a
 * flag de sessão `app.ledger_maintenance`.
 *
 * `SET LOCAL` só vale dentro de uma transação, e a transação interativa do
 * Prisma garante que o `deleteMany` rode na **mesma conexão** do pool onde
 * a flag foi ligada — com `$executeRaw` solto, o delete poderia cair em
 * outra conexão e esbarrar na trigger.
 */
export async function deleteLedgerEntries(
  prisma: PrismaLike,
  where: Prisma.LedgerEntryWhereInput,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.ledger_maintenance = 'on'`);
    await tx.ledgerEntry.deleteMany({ where });
  });
}
