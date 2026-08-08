import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { loginUser } from '../api/auth';
import { ErrorMessage } from '../components/ErrorMessage';
import { useAuth } from '../context/auth-context';
import { getErrorMessage } from '../lib/error-message';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const mutation = useMutation({
    mutationFn: () => loginUser(email, password),
    onSuccess: (tokens) => {
      login(tokens);
      const redirectTo =
        (location.state as { from?: string } | null)?.from ?? '/';
      void navigate(redirectTo, { replace: true });
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <div className="auth-page">
      <h1>Entrar</h1>
      <form onSubmit={handleSubmit} className="auth-form">
        <label>
          E-mail
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label>
          Senha
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {mutation.isError && (
          <ErrorMessage>{getErrorMessage(mutation.error)}</ErrorMessage>
        )}
        <button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Entrando...' : 'Entrar'}
        </button>
      </form>
      <p>
        Não tem conta? <Link to="/register">Cadastre-se</Link>
      </p>
    </div>
  );
}
