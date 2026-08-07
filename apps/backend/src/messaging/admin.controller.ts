import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DlqService } from './dlq.service';

// Sem controle de papel/role ainda (fora do escopo do projeto até agora)
// — protegido só por autenticação, qualquer usuário logado pode acessar.
// Revisar quando/se um conceito de "admin" for introduzido.
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
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
