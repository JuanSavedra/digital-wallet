import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getMyStatement } from '../api/wallets';
import { centsToBRL } from '../lib/money';
import { getErrorMessage } from '../lib/error-message';

export function StatementPage() {
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ['statement', page],
    queryFn: () => getMyStatement(page),
    placeholderData: (previous) => previous,
  });

  return (
    <section>
      <h1>Extrato</h1>
      {isLoading && <p>Carregando...</p>}
      {isError && <p className="form-error">{getErrorMessage(error)}</p>}
      {data && (
        <>
          {data.entries.length === 0 ? (
            <p>Nenhuma movimentação nesta página.</p>
          ) : (
            <ul className="statement-list">
              {data.entries.map((entry) => (
                <li key={entry.id}>
                  <span
                    className={`direction ${entry.direction.toLowerCase()}`}
                  >
                    {entry.direction === 'DEBIT' ? '-' : '+'}
                    {centsToBRL(entry.amount)}
                  </span>
                  <span>{new Date(entry.createdAt).toLocaleString('pt-BR')}</span>
                  <Link to={`/transactions/${entry.transactionId}`}>
                    ver transação
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="pagination">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Anterior
            </button>
            <span>Página {page}</span>
            <button
              type="button"
              disabled={isFetching || data.entries.length === 0}
              onClick={() => setPage((p) => p + 1)}
            >
              Próxima
            </button>
          </div>
        </>
      )}
    </section>
  );
}
