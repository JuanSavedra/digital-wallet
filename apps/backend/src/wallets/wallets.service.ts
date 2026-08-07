import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Wallet } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WalletsService {
  constructor(private readonly prisma: PrismaService) {}

  createForUser(userId: string): Promise<Wallet> {
    return this.prisma.wallet.create({ data: { userId, balance: 0n } });
  }

  findByUserId(userId: string): Promise<Wallet | null> {
    return this.prisma.wallet.findUnique({ where: { userId } });
  }

  findById(id: string): Promise<Wallet | null> {
    return this.prisma.wallet.findUnique({ where: { id } });
  }

  async assertOwnership(walletId: string, userId: string): Promise<Wallet> {
    const wallet = await this.findById(walletId);
    if (!wallet) {
      throw new NotFoundException('Carteira não encontrada');
    }
    if (wallet.userId !== userId) {
      throw new ForbiddenException('Você não tem acesso a esta carteira');
    }
    return wallet;
  }
}
