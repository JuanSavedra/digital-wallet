import { isAxiosError } from 'axios';

export function getErrorMessage(error: unknown): string {
  if (isAxiosError(error)) {
    const message = (error.response?.data as { message?: string | string[] })
      ?.message;
    if (Array.isArray(message)) return message.join(', ');
    if (message) return message;
    if (error.response?.status === 429) {
      return 'Muitas tentativas, aguarde um pouco e tente de novo.';
    }
    if (!error.response) return 'Não foi possível conectar à API.';
  }
  return 'Algo deu errado, tente novamente.';
}
