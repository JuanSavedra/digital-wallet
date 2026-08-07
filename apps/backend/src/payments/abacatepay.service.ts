import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface AbacatePayProduct {
  id: string;
}

export interface AbacatePayCheckout {
  id: string;
  url: string;
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';
}

interface AbacatePayEnvelope<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

/**
 * Cliente para a API v2 do AbacatePay (https://docs.abacatepay.com),
 * usada só em dev mode (o projeto nunca sai do modo de desenvolvimento —
 * ver TODO.md). Endpoints e formato de resposta ({ success, data, error })
 * confirmados batendo direto na API real durante a implementação; a
 * documentação pública não estava totalmente atualizada com a v2.
 */
@Injectable()
export class AbacatePayService {
  private readonly logger = new Logger(AbacatePayService.name);

  constructor(private readonly configService: ConfigService) {}

  async createProduct(
    externalId: string,
    name: string,
    priceCents: number,
  ): Promise<AbacatePayProduct> {
    const data = await this.request<AbacatePayProduct>('/products/create', {
      method: 'POST',
      body: { externalId, name, price: priceCents, currency: 'BRL' },
    });
    return data;
  }

  /**
   * CARD ficou de fora: a conta AbacatePay usada em dev retorna
   * "CARD is not available for this store" (restrição de conta, não de
   * código) e habilitar isso exigiria contato com o suporte deles. PIX
   * funciona isolado e cobre a mesma necessidade (dar saldo pra testar
   * transferências) sem esse bloqueio.
   */
  async createPixCheckout(
    productId: string,
    returnUrl: string,
    completionUrl: string,
  ): Promise<AbacatePayCheckout> {
    const data = await this.request<AbacatePayCheckout>('/checkouts/create', {
      method: 'POST',
      body: {
        items: [{ id: productId, quantity: 1 }],
        methods: ['PIX'],
        returnUrl,
        completionUrl,
      },
    });
    return data;
  }

  /**
   * Não existe endpoint pra buscar um checkout específico por id na v2
   * (`/checkouts/one` retorna 404) — só listar todos e filtrar. Aceitável
   * pro volume de um projeto que nunca sai do dev mode.
   */
  async findCheckoutById(id: string): Promise<AbacatePayCheckout | null> {
    const checkouts = await this.request<AbacatePayCheckout[]>(
      '/checkouts/list',
      { method: 'GET' },
    );
    return checkouts.find((checkout) => checkout.id === id) ?? null;
  }

  private async request<T>(
    path: string,
    options: { method: 'GET' | 'POST'; body?: unknown },
  ): Promise<T> {
    const baseUrl = this.configService.getOrThrow<string>('ABACATEPAY_BASE_URL');
    const apiKey = this.configService.getOrThrow<string>('ABACATEPAY_API_KEY');

    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const envelope = (await response.json()) as AbacatePayEnvelope<T>;

    if (!response.ok || !envelope.success || envelope.data === null) {
      this.logger.error(
        `AbacatePay ${options.method} ${path} falhou: ${envelope.error ?? response.statusText}`,
      );
      throw new HttpException(
        `Falha ao comunicar com o AbacatePay: ${envelope.error ?? 'erro desconhecido'}`,
        response.status || 502,
      );
    }

    return envelope.data;
  }
}
