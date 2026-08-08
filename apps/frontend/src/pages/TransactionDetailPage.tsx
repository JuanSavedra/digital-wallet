import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { getTransaction } from '../api/transactions';
import { ErrorMessage } from '../components/ErrorMessage';
import { centsToBRL } from '../lib/money';
import { getErrorMessage } from '../lib/error-message';
import type { TransactionStatus } from '../api/types';

const STATUS_LABEL: Record<TransactionStatus, string> = {
  PENDING: 'Processando...',
  COMPLETED: 'Concluída',
  FAILED: 'Falhou',
};

export function TransactionDetailPage() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['transaction', id],
    queryFn: () => getTransaction(id!),
    enabled: Boolean(id),
    // Enquanto pendente, faz polling: a conclusão da transferência é
    // síncrona no backend atual, mas isso deixa a tela pronta pro dia em
    // que virar assíncrono de verdade sem precisar mudar nada aqui.
    refetchInterval: (query) =>
      query.state.data?.status === 'PENDING' ? 1_000 : false,
  });

  if (isLoading) return <p>Carregando...</p>;
  if (isError) return <ErrorMessage>{getErrorMessage(error)}</ErrorMessage>;
  if (!data) return null;

  return (
    <section>
      <h1>Transação</h1>
      <dl className="transaction-detail">
        <dt>Status</dt>
        <dd className={`status ${data.status.toLowerCase()}`}>
          {STATUS_LABEL[data.status]}
        </dd>
        <dt>Valor</dt>
        <dd className="figure">{centsToBRL(data.amount)}</dd>
        <dt>Origem</dt>
        <dd>
          <code>{data.originWalletId}</code>
        </dd>
        <dt>Destino</dt>
        <dd>
          <code>{data.destinationWalletId}</code>
        </dd>
        <dt>Criada em</dt>
        <dd>{new Date(data.createdAt).toLocaleString('pt-BR')}</dd>
      </dl>
      <Link to="/statement">Voltar ao extrato</Link>
    </section>
  );
}
