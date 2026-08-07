export async function poll<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  { timeoutMs = 8_000, intervalMs = 150 } = {},
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('timeout aguardando condição');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
