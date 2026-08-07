import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { getDeposit } from '../api/deposits';
import { getErrorMessage } from '../lib/error-message';

const POLL_INTERVAL_MS = 2000;

/**
 * Destino do returnUrl/completionUrl do checkout da AbacatePay. Chama o
 * endpoint de confirmação por conta própria (em vez de só exibir uma
 * mensagem estática) porque a aba original do Dashboard pode ter sido
 * fechada, recarregada ou navegado pra outro lugar nesse meio tempo —
 * sem isso, nada mais chamaria o backend pra reconfirmar esse depósito
 * específico. `confirmPaid` no backend é idempotente (só credita uma vez),
 * então essa confirmação "extra" nunca duplica o depósito da aba original.
 *
 * O redirect da AbacatePay pode chegar aqui um instante antes do status
 * virar PAID do lado deles — por isso continua consultando em intervalos
 * em vez de checar só uma vez.
 */
export function DepositCallbackPage() {
  const [searchParams] = useSearchParams();
  const depositId = searchParams.get('depositId');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['deposit', depositId],
    queryFn: () => getDeposit(depositId!),
    enabled: depositId !== null,
    refetchInterval: (query) =>
      query.state.data?.status === 'PENDING' ? POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: true,
  });

  return (
    <section>
      <h1>Pagamento processado</h1>
      {depositId === null && (
        <p>Você já pode fechar esta aba.</p>
      )}
      {depositId !== null && isLoading && <p>Confirmando pagamento...</p>}
      {depositId !== null && isError && (
        <p className="form-error">{getErrorMessage(error)}</p>
      )}
      {data?.status === 'PAID' && (
        <p className="deposit-success">
          Pagamento confirmado! Seu saldo já foi atualizado. Você já pode
          fechar esta aba.
        </p>
      )}
      {data?.status === 'PENDING' && (
        <p>Confirmando pagamento com a AbacatePay...</p>
      )}
      {(data?.status === 'EXPIRED' || data?.status === 'CANCELLED') && (
        <p className="form-error">O pagamento não foi concluído.</p>
      )}
    </section>
  );
}
