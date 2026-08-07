import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../auth/guards/admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DlqService } from './dlq.service';

// Autenticação + autorização: `AdminGuard` restringe estas rotas à lista
// `ADMIN_EMAILS`. Antes do Escopo 13 bastava estar logado, o que dava a
// qualquer usuário o poder de reprocessar (POST /replay) eventos de
// transação de terceiros.
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/dlq')
export class AdminController {
  constructor(private readonly dlqService: DlqService) {}

  @Get()
  getStatus() {
    return this.dlqService.getStatus();
  }

  @Post('replay')
  async replay() {
    const replayed = await this.dlqService.replay();
    return { replayed };
  }
}
