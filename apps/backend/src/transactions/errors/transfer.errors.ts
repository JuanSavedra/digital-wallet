/** Erros internos de domínio usados para decidir, fora da transação SQL
 * (que já foi revertida pelo Prisma), qual HTTP exception lançar e marcar
 * a transação como FAILED antes de propagar ao cliente. */

export class InsufficientBalanceError extends Error {
  constructor() {
    super('Saldo insuficiente');
  }
}

export class ConcurrentModificationError extends Error {
  constructor() {
    super('Conflito de concorrência ao atualizar o saldo, tente novamente');
  }
}
