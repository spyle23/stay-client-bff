import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import { RedisService } from '../../redis/redis.service';
import { RedisHealthIndicator } from './redis.health';

describe('RedisHealthIndicator', () => {
  const ping = jest.fn();
  let indicator: RedisHealthIndicator;

  beforeEach(async () => {
    ping.mockReset();
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      providers: [
        RedisHealthIndicator,
        { provide: RedisService, useValue: { ping } },
      ],
    }).compile();
    indicator = moduleRef.get(RedisHealthIndicator);
  });

  it('up quand ping renvoie PONG', async () => {
    ping.mockResolvedValue('PONG');
    const res = await indicator.isHealthy('redis');
    expect(res.redis.status).toBe('up');
  });

  it('down quand ping échoue', async () => {
    ping.mockRejectedValue(new Error('connection refused'));
    const res = await indicator.isHealthy('redis');
    expect(res.redis.status).toBe('down');
  });
});
