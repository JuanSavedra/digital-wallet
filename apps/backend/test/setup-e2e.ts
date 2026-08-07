import { E2E_ADMIN_EMAIL } from './utils/e2e-admin';

// Desliga o rate limiting nas suítes e2e: elas registram dezenas de
// usuários e criam depósitos em sequência, então os limites reais fariam os
// testes falharem por 429 em vez de pelo comportamento sob teste.
//
// A suíte `security.e2e-spec.ts` religa a flag pontualmente para provar que
// o rate limit realmente funciona (`skipIf` é avaliado a cada requisição).
process.env.RATE_LIMIT_DISABLED = 'true';

// Autoriza um único e-mail conhecido nas rotas /admin/dlq. Tem de acontecer
// aqui, antes do import de AppModule (ver comentário em utils/e2e-admin.ts).
process.env.ADMIN_EMAILS = E2E_ADMIN_EMAIL;
