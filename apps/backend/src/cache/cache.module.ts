import { Global, Module } from '@nestjs/common';
import { RedisLockService } from './redis-lock.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, RedisLockService],
  exports: [RedisService, RedisLockService],
})
export class CacheModule {}
