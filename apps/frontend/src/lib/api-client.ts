import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { getTokens, setTokens } from './token-store';

export const API_BASE_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  'http://localhost:3000/api/v1';

export const api = axios.create({ baseURL: API_BASE_URL });

// Instância separada, sem os interceptors abaixo — usada só para o
// próprio refresh, pra não entrar em loop com o interceptor de 401.
const refreshClient = axios.create({ baseURL: API_BASE_URL });

api.interceptors.request.use((config) => {
  const tokens = getTokens();
  if (tokens?.accessToken) {
    config.headers.Authorization = `Bearer ${tokens.accessToken}`;
  }
  return config;
});

let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const tokens = getTokens();
  if (!tokens?.refreshToken) {
    throw new Error('Sem refresh token disponível');
  }

  const { data } = await refreshClient.post<{
    accessToken: string;
    refreshToken: string;
  }>('/auth/refresh', { refreshToken: tokens.refreshToken });

  setTokens(data);
  return data.accessToken;
}

interface RetriableConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as RetriableConfig | undefined;
    const isAuthEndpoint = originalRequest?.url?.startsWith('/auth/');

    if (
      error.response?.status === 401 &&
      originalRequest &&
      !originalRequest._retry &&
      !isAuthEndpoint
    ) {
      originalRequest._retry = true;
      try {
        refreshPromise ??= refreshAccessToken().finally(() => {
          refreshPromise = null;
        });
        const newAccessToken = await refreshPromise;
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return api(originalRequest);
      } catch {
        setTokens(null);
      }
    }

    return Promise.reject(error);
  },
);
