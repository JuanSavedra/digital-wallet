import { api } from '../lib/api-client';
import type { AuthSession, RegisteredUser } from './types';

export async function registerUser(
  email: string,
  password: string,
): Promise<RegisteredUser> {
  const { data } = await api.post<RegisteredUser>('/auth/register', {
    email,
    password,
  });
  return data;
}

export async function loginUser(
  email: string,
  password: string,
): Promise<AuthSession> {
  const { data } = await api.post<AuthSession>('/auth/login', {
    email,
    password,
  });
  return data;
}

/** Sem corpo: o backend identifica a sessão pelo cookie httpOnly e o limpa. */
export async function logoutUser(): Promise<void> {
  await api.post('/auth/logout', {});
}
