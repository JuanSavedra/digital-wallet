export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

const STORAGE_KEY = 'dw_tokens';
const listeners = new Set<() => void>();

function loadFromStorage(): Tokens | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

let tokens: Tokens | null = loadFromStorage();

export function getTokens(): Tokens | null {
  return tokens;
}

export function setTokens(next: Tokens | null): void {
  tokens = next;
  if (next) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
  listeners.forEach((listener) => listener());
}

export function subscribeToTokens(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
