import { REDACTED, redact } from './redact';

describe('redact', () => {
  it('masks values of sensitive keys anywhere in the object tree', () => {
    const result = redact({
      email: 'user@example.com',
      password: 'senha-forte-123',
      nested: { refreshToken: 'abc', passwordHash: '$2b$10$xyz' },
      headers: { authorization: 'Bearer abc', 'x-api-key': 'k' },
    });

    expect(result).toEqual({
      email: 'user@example.com',
      password: REDACTED,
      nested: { refreshToken: REDACTED, passwordHash: REDACTED },
      headers: { authorization: REDACTED, 'x-api-key': REDACTED },
    });
  });

  it('masks a JWT embedded in free text, where there is no key to match on', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.s1gn4tur3-h3r3_ok';

    expect(redact(`falha ao validar o token ${jwt} do usuário`)).toBe(
      `falha ao validar o token ${REDACTED} do usuário`,
    );
  });

  it('masks credentials embedded in connection URLs', () => {
    // O caso real: um erro do Prisma/amqplib traz a URL de conexão inteira,
    // senha incluída, na mensagem.
    expect(
      redact(
        'Cannot reach postgresql://wallet:s3nh4-real@postgres:5432/wallet',
      ),
    ).toBe(`Cannot reach postgresql://wallet:${REDACTED}@postgres:5432/wallet`);
  });

  it('converts Error into name/message/stack instead of the empty object JSON.stringify produces', () => {
    const error = new Error('algo quebrou');

    const result = redact(error) as Record<string, unknown>;

    expect(JSON.stringify(error)).toBe('{}');
    expect(result.name).toBe('Error');
    expect(result.message).toBe('algo quebrou');
    expect(result.stack).toEqual(expect.stringContaining('algo quebrou'));
  });

  it('survives circular references without throwing', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node.self = node;

    expect(() => JSON.stringify(redact(node))).not.toThrow();
    expect((redact(node) as Record<string, unknown>).self).toBe('[Circular]');
  });

  it('leaves non-sensitive data untouched', () => {
    expect(redact({ walletId: 'w-1', amount: '1000', page: 2 })).toEqual({
      walletId: 'w-1',
      amount: '1000',
      page: 2,
    });
  });
});
