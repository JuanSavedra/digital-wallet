/**
 * Tema claro/escuro como módulo com pub/sub (mesmo padrão de `token-store.ts`),
 * persistido em `localStorage`. Sem escolha explícita do usuário, o tema segue
 * `prefers-color-scheme` via CSS puro (ver `index.css`) — este módulo só entra
 * em ação quando o usuário alterna manualmente, escrevendo `data-theme` no
 * `<html>` para sobrepor a preferência do sistema.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'wallet:theme';
const listeners = new Set<() => void>();

function readStoredTheme(): Theme | null {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : null;
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

let theme: Theme = readStoredTheme() ?? systemTheme();

function applyThemeAttribute(value: Theme): void {
  document.documentElement.setAttribute('data-theme', value);
}

applyThemeAttribute(theme);

export function getTheme(): Theme {
  return theme;
}

export function setTheme(next: Theme): void {
  theme = next;
  localStorage.setItem(STORAGE_KEY, next);
  applyThemeAttribute(next);
  listeners.forEach((listener) => listener());
}

export function toggleTheme(): void {
  setTheme(theme === 'dark' ? 'light' : 'dark');
}

export function subscribeToTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
