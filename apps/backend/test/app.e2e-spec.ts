import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/setup-app';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  it('/api/v1 (GET) returns Hello World', () => {
    return request(app.getHttpServer())
      .get('/api/v1')
      .expect(200)
      .expect('Hello World!');
  });

  it('sets an x-request-id header on the response', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1');

    expect(response.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('/api/v1/does-not-exist (GET) returns the standardized error shape', async () => {
    const response = await request(app.getHttpServer()).get(
      '/api/v1/does-not-exist',
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual(
      expect.objectContaining({
        statusCode: 404,
        path: '/api/v1/does-not-exist',
      }),
    );
  });

  afterEach(async () => {
    await app.close();
  });
});
