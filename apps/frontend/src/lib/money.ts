export function centsToBRL(cents: string | number): string {
  const value = Number(cents) / 100;
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Converte uma string digitada em reais ("10,50" ou "10.50") para
 * centavos inteiros. Retorna null se não for um valor positivo válido. */
export function parseReaisToCents(input: string): number | null {
  const normalized = input.trim().replace(',', '.');
  if (!normalized) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}
