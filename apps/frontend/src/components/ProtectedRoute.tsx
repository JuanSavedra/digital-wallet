import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/auth-context';

export function ProtectedRoute() {
  const { status } = useAuth();

  // Enquanto o refresh de bootstrap não respondeu ainda não dá para dizer se
  // há sessão. Redirecionar aqui expulsaria para /login todo usuário que
  // simplesmente recarregou a página.
  if (status === 'unknown') {
    return <p aria-busy="true">Carregando sessão…</p>;
  }

  if (status !== 'authenticated') {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
