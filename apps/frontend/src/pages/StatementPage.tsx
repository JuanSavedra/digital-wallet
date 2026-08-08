import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getMyStatement } from '../api/wallets';
import { ErrorMessage } from '../components/ErrorMessage';
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
      {isError && <ErrorMessage>{getErrorMessage(error)}</ErrorMessage>}
      {data && (
        <>
          {data.entries.length === 0 ? (
            <p>Nenhuma movimentação nesta página.</p>
          ) : (
            <ul className="statement-list">
              {data.entries.map((entry) => {
                const isDebit = entry.direction === 'DEBIT';
                return (
                  <li key={entry.id}>
                    <span
                      className={`direction ${entry.direction.toLowerCase()}`}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        {isDebit ? (
                          <path d="M12 5v14M6 13l6 6 6-6" />
                        ) : (
                          <path d="M12 19V5M6 11l6-6 6 6" />
                        )}
                      </svg>
                      {isDebit ? '-' : '+'}
                      {centsToBRL(entry.amount)}
                    </span>
                    <span className="statement-entry-meta">
                      <time>
                        {new Date(entry.createdAt).toLocaleString('pt-BR')}
                      </time>
                      {entry.source === 'deposit' ? (
                        <span>Depósito</span>
                      ) : (
                        <Link to={`/transactions/${entry.transactionId}`}>
                          ver transação
                        </Link>
                      )}
                    </span>
                  </li>
                );
              })}
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
