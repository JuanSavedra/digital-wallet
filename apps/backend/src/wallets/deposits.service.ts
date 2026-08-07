import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WalletDeposit } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AbacatePayService } from '../payments/abacatepay.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from './wallets.service';

const PRODUCT_NAME = 'Depósito na carteira';

@Injectable()
export class DepositsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly abacatePayService: AbacatePayService,
    private readonly walletsService: WalletsService,
    private readonly configService: ConfigService,
  ) {}

  async createDeposit(
    userId: string,
    amountCents: number,
  ): Promise<WalletDeposit> {
    const wallet = await this.walletsService.findByUserId(userId);
    if (!wallet) {
      throw new NotFoundException('Carteira não encontrada');
    }

    const frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
    // Gerado com antecedência (em vez de deixar o Prisma escolher o id no
    // create) pra poder embutir na callbackUrl: assim a própria aba do
    // checkout consegue confirmar o pagamento ao ser redirecionada de
    // volta, sem depender só do polling da aba original continuar viva
    // (ela pode ter sido fechada, recarregada ou navegado pra outro lugar
    // nesse meio tempo).
    const depositId = randomUUID();
    const callbackUrl = `${frontendUrl}/deposits/callback?depositId=${depositId}`;

    // O checkout hospedado só cobra o preço de um produto existente (não
    // dá pra informar um valor solto na hora do checkout) — criamos um
    // produto novo por depósito com o preço exato pedido.
    const product = await this.abacatePayService.createProduct(
      randomUUID(),
      PRODUCT_NAME,
      amountCents,
    );
    const checkout = await this.abacatePayService.createPixCheckout(
      product.id,
      callbackUrl,
      callbackUrl,
    );

    return this.prisma.walletDeposit.create({
      data: {
        id: depositId,
        walletId: wallet.id,
        amount: BigInt(amountCents),
        providerChargeId: checkout.id,
        providerProductId: product.id,
        checkoutUrl: checkout.url,
        status: 'PENDING',
      },
    });
  }

  /**
   * Nunca confia no redirect do checkout (returnUrl/completionUrl são só
   * URLs que o navegador visita — não provam nada sozinhas). Sempre
   * reconfirma o status direto na AbacatePay antes de considerar pago.
   */
  async getDepositForUser(
    depositId: string,
    userId: string,
  ): Promise<WalletDeposit> {
    const deposit = await this.prisma.walletDeposit.findUnique({
      where: { id: depositId },
      include: { wallet: true },
    });
    if (!deposit) {
      throw new NotFoundException('Depósito não encontrado');
    }
    if (deposit.wallet.userId !== userId) {
      throw new ForbiddenException('Você não tem acesso a este depósito');
    }

    if (deposit.status !== 'PENDING') {
      return deposit;
    }

    const checkout = await this.abacatePayService.findCheckoutById(
      deposit.providerChargeId,
    );
    if (!checkout || checkout.status === 'PENDING') {
      return deposit;
    }

    if (checkout.status === 'PAID') {
      return this.confirmPaid(deposit.id, deposit.walletId, deposit.amount);
    }

    // O enum local não tem REFUNDED (não faz sentido pra um depósito que
    // nunca chegou a ser pago) — trata como CANCELLED.
    const status = checkout.status === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED';
    return this.prisma.walletDeposit.update({
      where: { id: deposit.id },
      data: { status },
    });
  }

  /**
   * Só credita o saldo se conseguir mudar o status de PENDING -> PAID
   * nesse UPDATE (mesmo truque de lock otimista usado nas transferências).
   * Se duas checagens concorrentes chegarem aqui pro mesmo depósito, só
   * uma delas vê `count === 1` e credita — a outra encontra o depósito já
   * pago e não faz nada, evitando o depósito duplo.
   */
  private async confirmPaid(
    depositId: string,
    walletId: string,
    amount: bigint,
  ): Promise<WalletDeposit> {
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.walletDeposit.updateMany({
        where: { id: depositId, status: 'PENDING' },
        data: { status: 'PAID', paidAt: new Date() },
      });

      if (updated.count === 1) {
        await tx.wallet.update({
          where: { id: walletId },
          data: { balance: { increment: amount } },
        });
      }

      return tx.walletDeposit.findUniqueOrThrow({ where: { id: depositId } });
    });

    await this.walletsService.invalidateWalletCaches(walletId);
    return result;
  }
}
