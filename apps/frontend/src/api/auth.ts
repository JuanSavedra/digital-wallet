import { api } from '../lib/api-client';
import type { AuthTokens, RegisteredUser } from './types';

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
): Promise<AuthTokens> {
  const { data } = await api.post<AuthTokens>('/auth/login', {
    email,
    password,
  });
  return data;
}

export async function logoutUser(refreshToken: string): Promise<void> {
  await api.post('/auth/logout', { refreshToken });
}
