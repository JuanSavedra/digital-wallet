import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import type { AuthTokens } from './interfaces/token-payload.interface';
import {
  clearRefreshCookie,
  readRefreshToken,
  setRefreshCookie,
} from './refresh-cookie';

@ApiTags('auth')
@Controller('auth')
// Todo o controller de auth é throttled: além do login (força bruta de
// senha), `register` era um endpoint anônimo que rodava bcrypt e criava
// linhas no banco sem limite nenhum, e `refresh` verifica JWT a cada
// chamada. O guard fica por rota/controller, nunca global — registrá-lo
// como APP_GUARD já quebrou transferência e criação de usuários antes.
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto.email, dto.password);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const tokens = await this.authService.login(dto.email, dto.password);
    return this.respondWithTokens(tokens, response);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const refreshToken = readRefreshToken(request, dto.refreshToken);
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token ausente');
    }

    const tokens = await this.authService.refresh(refreshToken);
    return this.respondWithTokens(tokens, response);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(
    @Body() dto: RefreshTokenDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const refreshToken = readRefreshToken(request, dto.refreshToken);
    // O cookie é limpo mesmo se não havia token: logout precisa ser
    // idempotente e nunca deixar credencial para trás no navegador.
    clearRefreshCookie(response, this.configService);

    if (refreshToken) {
      await this.authService.logout(refreshToken);
    }
  }

  /**
   * O refresh token **não** volta no corpo: ele sai apenas no cookie
   * httpOnly, fora do alcance de qualquer JavaScript da página. É isso que
   * impede um XSS de exfiltrar a credencial de longa duração da sessão — o
   * access token, que continua no corpo, expira em minutos.
   *
   * Clientes que não são navegador (curl, integrações) leem o cookie da
   * resposta normalmente, via cookie jar.
   */
  private respondWithTokens(
    tokens: AuthTokens,
    response: Response,
  ): { accessToken: string } {
    setRefreshCookie(
      response,
      this.configService,
      tokens.refreshToken,
      this.authService.getRefreshTokenTtlMs(),
    );
    return { accessToken: tokens.accessToken };
  }
}
