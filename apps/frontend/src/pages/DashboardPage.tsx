import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { getMyWallet } from '../api/wallets';
import { centsToBRL } from '../lib/money';
import { getErrorMessage } from '../lib/error-message';

export function DashboardPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['wallet'],
    queryFn: getMyWallet,
  });

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
    </section>
  );
}
