import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { depositToMyWallet, getMyWallet } from '../api/wallets';
import { getErrorMessage } from '../lib/error-message';
import { centsToBRL, parseReaisToCents } from '../lib/money';

export function DashboardPage() {
  const queryClient = useQueryClient();
  const [depositInput, setDepositInput] = useState('');
  const [depositError, setDepositError] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['wallet'],
    queryFn: getMyWallet,
  });

  const depositMutation = useMutation({
    mutationFn: depositToMyWallet,
    onSuccess: async () => {
      setDepositInput('');
      await queryClient.invalidateQueries({ queryKey: ['wallet'] });
    },
  });

  function handleDeposit(event: FormEvent) {
    event.preventDefault();
    setDepositError(null);

    const cents = parseReaisToCents(depositInput);
    if (!cents) {
      setDepositError('Informe um valor válido, maior que zero.');
      return;
    }
    depositMutation.mutate(cents);
  }

  if (isLoading) return <p>Carregando saldo...</p>;
  if (isError) return <p className="form-error">{getErrorMessage(error)}</p>;
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
          Não existe rail de captação externa neste projeto (PIX, cartão
          etc.) — isso só serve pra você ter saldo e testar transferências.
        </p>
        <form onSubmit={handleDeposit} className="auth-form">
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
          {(depositError ?? depositMutation.isError) && (
            <p className="form-error">
              {depositError ?? getErrorMessage(depositMutation.error)}
            </p>
          )}
          <button type="submit" disabled={depositMutation.isPending}>
            {depositMutation.isPending ? 'Adicionando...' : 'Adicionar saldo'}
          </button>
        </form>
      </div>
    </section>
  );
}
