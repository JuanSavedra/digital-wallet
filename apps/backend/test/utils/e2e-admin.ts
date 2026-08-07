/**
 * E-mail com acesso às rotas /admin/dlq nas suítes e2e.
 *
 * Precisa ser definido em `process.env.ADMIN_EMAILS` **antes** de qualquer
 * import de `AppModule`: `ConfigModule.forRoot` valida e congela o ambiente
 * no momento em que o módulo é importado, não quando o app é criado — por
 * isso a variável é setada no `setupFiles` do Jest (setup-e2e.ts) e não num
 * `beforeAll`.
 */
export const E2E_ADMIN_EMAIL = 'e2e-dlq-admin@example.com';
