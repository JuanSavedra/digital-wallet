import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { getAccessToken, markAnonymous, setAccessToken } from './token-store';

export const API_BASE_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  'http://localhost:3000/api/v1';

// `withCredentials` é obrigatório agora: o refresh token vive num cookie
// httpOnly e o navegador só o envia numa chamada cross-origin se a
// requisição pedir credenciais explicitamente (do outro lado, o backend
// responde com uma origem específica no CORS — `*` é proibido com
// credenciais, ver setup-app.ts).
export const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
});

// Instância separada, sem os interceptors abaixo — usada só para o
// próprio refresh, pra não entrar em loop com o interceptor de 401.
const refreshClient = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const accessToken = getAccessToken();
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

let refreshPromise: Promise<string> | null = null;

/**
 * Não recebe nem envia o refresh token: ele vai sozinho no cookie httpOnly.
 * O corpo vazio é intencional.
 */
async function refreshAccessToken(): Promise<string> {
  const { data } = await refreshClient.post<{ accessToken: string }>(
    '/auth/refresh',
    {},
  );

  setAccessToken(data.accessToken);
  return data.accessToken;
}

/** Deduplica refreshes concorrentes (o mesmo 401 pode atingir várias queries
 * ao mesmo tempo) reaproveitando a promise em andamento. */
function sharedRefresh(): Promise<string> {
  refreshPromise ??= refreshAccessToken().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

/**
 * Tenta restaurar a sessão na inicialização da app. Como o access token
 * agora só existe em memória, um F5 sempre começa sem ele — é o cookie de
 * refresh que diz se ainda há sessão. Falhar aqui é o caso normal de
 * "visitante não logado", não um erro.
 */
export async function bootstrapSession(): Promise<void> {
  try {
    await sharedRefresh();
  } catch {
    markAnonymous();
  }
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
        const newAccessToken = await sharedRefresh();
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return api(originalRequest);
      } catch {
        markAnonymous();
      }
    }

    return Promise.reject(error);
  },
);
