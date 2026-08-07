import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { registerUser } from '../api/auth';
import { getErrorMessage } from '../lib/error-message';

export function RegisterPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const mutation = useMutation({
    mutationFn: () => registerUser(email, password),
    onSuccess: () => {
      void navigate('/login', {
        state: { registered: true },
        replace: true,
      });
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <div className="auth-page">
      <h1>Criar conta</h1>
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
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        {mutation.isError && (
          <p className="form-error">{getErrorMessage(mutation.error)}</p>
        )}
        <button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Criando...' : 'Criar conta'}
        </button>
      </form>
      <p>
        Já tem conta? <Link to="/login">Entrar</Link>
      </p>
    </div>
  );
}
