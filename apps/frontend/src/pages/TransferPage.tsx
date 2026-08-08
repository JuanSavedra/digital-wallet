import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { transfer } from '../api/transactions';
import { lookupWalletByEmail } from '../api/wallets';
import { ErrorMessage } from '../components/ErrorMessage';
import { getErrorMessage } from '../lib/error-message';
import { parseReaisToCents } from '../lib/money';

export function TransferPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [recipientEmail, setRecipientEmail] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  // Gerada uma vez por "tentativa": se o request falhar por erro de rede
  // (sem resposta do servidor), reenviar com a MESMA chave é seguro e é o
  // que garante a idempotência de verdade. Só trocamos a chave quando o
  // servidor já respondeu com um erro definitivo (ex.: saldo insuficiente
  // marca a transação como FAILED, e essa chave nunca mais vai ser aceita).
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const mutation = useMutation({
    mutationFn: async (amountCents: number) => {
      const destinationWalletId = await lookupWalletByEmail(
        recipientEmail.trim(),
      );
      return transfer(destinationWalletId, amountCents, idempotencyKey);
    },
    onSuccess: async (transaction) => {
      setIdempotencyKey(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: ['wallet'] });
      await queryClient.invalidateQueries({ queryKey: ['statement'] });
      void navigate(`/transactions/${transaction.id}`);
    },
    onError: (error) => {
      if (isAxiosError(error) && error.response) {
        setIdempotencyKey(crypto.randomUUID());
      }
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setValidationError(null);

    const cents = parseReaisToCents(amountInput);
    if (!cents) {
      setValidationError('Informe um valor válido, maior que zero.');
      return;
    }
    if (!recipientEmail.trim()) {
      setValidationError('Informe o e-mail do destinatário.');
      return;
    }

    mutation.mutate(cents);
  }

  return (
    <section>
      <h1>Nova transferência</h1>
      <form onSubmit={handleSubmit} className="auth-form">
        <label>
          E-mail do destinatário
          <input
            type="email"
            required
            value={recipientEmail}
            onChange={(e) => setRecipientEmail(e.target.value)}
            placeholder="destinatario@example.com"
          />
        </label>
        <label>
          Valor (R$)
          <input
            type="text"
            inputMode="decimal"
            required
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            placeholder="10,00"
          />
        </label>
        {(validationError ?? mutation.isError) && (
          <ErrorMessage>
            {validationError ?? getErrorMessage(mutation.error)}
          </ErrorMessage>
        )}
        <button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Enviando...' : 'Transferir'}
        </button>
        <p className="idempotency-hint">
          Idempotency-Key desta tentativa: <code>{idempotencyKey}</code>
        </p>
      </form>
    </section>
  );
}
