import { ConfigService } from '@nestjs/config';
import { connect } from 'amqplib';
import { RabbitMqService } from './rabbitmq.service';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

describe('RabbitMqService', () => {
  let channel: { close: jest.Mock };
  let connection: { close: jest.Mock; createConfirmChannel: jest.Mock };
  let configService: jest.Mocked<ConfigService>;

  beforeEach(() => {
    channel = { close: jest.fn().mockResolvedValue(undefined) };
    connection = {
      close: jest.fn().mockResolvedValue(undefined),
      createConfirmChannel: jest.fn().mockResolvedValue(channel),
    };
    (connect as jest.Mock).mockResolvedValue(connection);
    configService = {
      getOrThrow: jest.fn().mockReturnValue('amqp://localhost'),
    } as unknown as jest.Mocked<ConfigService>;
  });

  function createService(): RabbitMqService {
    return new RabbitMqService(configService);
  }

  it('closes the channel and the connection on destroy', async () => {
    const service = createService();
    await service.getConnection();

    await service.onModuleDestroy();

    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });

  // Regressão: se a conexão já caiu sozinha antes do shutdown, `close()`
  // rejeita. `NestApplicationContext.close()` roda `onModuleDestroy` de
  // todos os providers num loop sequencial ANTES de limpar os
  // `@Interval`/`@Cron` do ScheduleModule — uma exceção aqui aborta esse
  // loop e deixa pollers como o `DlqMetricsPoller` disparando pra sempre
  // contra uma conexão morta, travando o processo (e qualquer `app.close()`
  // de teste e2e esperando por ele).
  it('does not throw when the channel or the connection are already closed', async () => {
    channel.close.mockRejectedValue(new Error('Channel closed'));
    connection.close.mockRejectedValue(new Error('Connection closed'));
    const service = createService();
    await service.getConnection();

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(connection.close).toHaveBeenCalled();
  });
});
