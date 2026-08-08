import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { createDeposit, getDeposit } from '../api/deposits';
import { getMyWallet } from '../api/wallets';
import { ErrorMessage } from '../components/ErrorMessage';
import { getErrorMessage } from '../lib/error-message';
import { centsToBRL, parseReaisToCents } from '../lib/money';

const POLL_INTERVAL_MS = 3000;
const ACTIVE_DEPOSIT_STORAGE_KEY = 'wallet:activeDepositId';

export function DashboardPage() {
  const queryClient = useQueryClient();
  const [depositInput, setDepositInput] = useState('');
  const [depositError, setDepositError] = useState<string | null>(null);
  // Persistido em localStorage: sem isso, um F5 ou navegar pra outra tela
  // enquanto o depósito ainda está PENDING perde essa referência e o
  // polling nunca mais retoma sozinho para aquele depósito.
  const [activeDepositId, setActiveDepositIdState] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_DEPOSIT_STORAGE_KEY),
  );

  function setActiveDepositId(id: string | null) {
    setActiveDepositIdState(id);
    if (id === null) {
      localStorage.removeItem(ACTIVE_DEPOSIT_STORAGE_KEY);
    } else {
      localStorage.setItem(ACTIVE_DEPOSIT_STORAGE_KEY, id);
    }
  }

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['wallet'],
    queryFn: getMyWallet,
  });

  const createDepositMutation = useMutation({
    mutationFn: createDeposit,
    onSuccess: (deposit) => {
      setDepositInput('');
      setActiveDepositId(deposit.id);
      window.open(deposit.checkoutUrl, '_blank', 'noopener,noreferrer');
    },
  });

  const depositQuery = useQuery({
    queryKey: ['deposit', activeDepositId],
    queryFn: () => getDeposit(activeDepositId!),
    enabled: activeDepositId !== null,
    refetchInterval: (query) =>
      query.state.data?.status === 'PENDING' ? POLL_INTERVAL_MS : false,
    // O checkout abre numa aba nova, então esta aba (Dashboard) fica em
    // segundo plano boa parte do tempo em que o usuário está pagando — sem
    // isso, o TanStack Query pausa o polling em background e a confirmação
    // só chegaria quando o usuário voltasse manualmente pra esta aba.
    refetchIntervalInBackground: true,
  });

  const deposit = depositQuery.data;

  useEffect(() => {
    if (deposit?.status === 'PAID') {
      void queryClient.invalidateQueries({ queryKey: ['wallet'] });
      void queryClient.invalidateQueries({ queryKey: ['statement'] });
    }
  }, [deposit?.status, queryClient]);

  function handleCreateDeposit(event: FormEvent) {
    event.preventDefault();
    setDepositError(null);

    const cents = parseReaisToCents(depositInput);
    if (!cents) {
      setDepositError('Informe um valor válido, maior que zero.');
      return;
    }
    createDepositMutation.mutate(cents);
  }

  function handleReset() {
    setActiveDepositId(null);
  }

  if (isLoading) return <p>Carregando saldo...</p>;
  if (isError) return <ErrorMessage>{getErrorMessage(error)}</ErrorMessage>;
  if (!data) return null;

  return (
    <section>
      <h1>Sua carteira</h1>
      <p className="balance">{centsToBRL(data.balance)}</p>
      <p className="wallet-id">
        Para receber, compartilhe o e-mail desta conta — quem for te
        transferir usa ele na tela de "Transferir". Id da carteira:{' '}
        <code>{data.id}</code>
      </p>
      <div className="actions">
        <Link to="/transfer" className="button-link">
          Nova transferência
        </Link>
        <Link to="/statement" className="button-link secondary">
          Ver extrato
        </Link>
      </div>

      <div className="deposit-box">
        <h2>Adicionar saldo</h2>
        <p className="deposit-hint">
          O pagamento é processado via PIX pela AbacatePay em modo de
          desenvolvimento — nenhuma cobrança real acontece. Use o QR Code ou
          o "Pix Copia e Cola" de teste fornecidos pela AbacatePay na tela de
          checkout.
        </p>

        {activeDepositId === null && (
          <form onSubmit={handleCreateDeposit} className="auth-form">
            <label>
              Valor (R$)
              <input
                type="text"
                inputMode="decimal"
                required
                value={depositInput}
                onChange={(e) => setDepositInput(e.target.value)}
                placeholder="100,00"
              />
            </label>
            {(depositError ?? createDepositMutation.isError) && (
              <ErrorMessage>
                {depositError ?? getErrorMessage(createDepositMutation.error)}
              </ErrorMessage>
            )}
            <button type="submit" disabled={createDepositMutation.isPending}>
              {createDepositMutation.isPending
                ? 'Gerando pagamento...'
                : 'Ir para pagamento'}
            </button>
          </form>
        )}

        {activeDepositId !== null && deposit && (
          <div className="deposit-status">
            {deposit.status === 'PENDING' && (
              <p>
                Aguardando confirmação do pagamento na aba de checkout que
                abrimos para você...{' '}
                <a href={deposit.checkoutUrl} target="_blank" rel="noreferrer">
                  reabrir checkout
                </a>
              </p>
            )}
            {deposit.status === 'PAID' && (
              <p className="deposit-success">
                Pagamento confirmado! Seu saldo já foi atualizado.
              </p>
            )}
            {(deposit.status === 'EXPIRED' || deposit.status === 'CANCELLED') && (
              <ErrorMessage>
                O pagamento não foi concluído (
                {deposit.status === 'EXPIRED' ? 'expirado' : 'cancelado'}
                ). Tente novamente.
              </ErrorMessage>
            )}
            <button type="button" onClick={handleReset}>
              {deposit.status === 'PENDING' ? 'Cancelar' : 'Fazer novo depósito'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
