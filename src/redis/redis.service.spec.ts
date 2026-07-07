import type { Redis } from 'ioredis';
import { RedisService } from './redis.service';

function makeFakeClient() {
  return {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    ping: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
  };
}

describe('RedisService', () => {
  let client: ReturnType<typeof makeFakeClient>;
  let service: RedisService;

  beforeEach(() => {
    client = makeFakeClient();
    service = new RedisService(client as unknown as Redis);
  });

  it('get délègue au client', async () => {
    client.get.mockResolvedValue('v');
    await expect(service.get('k')).resolves.toBe('v');
    expect(client.get).toHaveBeenCalledWith('k');
  });

  it('set sans TTL', async () => {
    await service.set('k', 'v');
    expect(client.set).toHaveBeenCalledWith('k', 'v');
  });

  it('set avec TTL utilise EX', async () => {
    await service.set('k', 'v', 60);
    expect(client.set).toHaveBeenCalledWith('k', 'v', 'EX', 60);
  });

  it('del délègue', async () => {
    client.del.mockResolvedValue(1);
    await expect(service.del('k')).resolves.toBe(1);
  });

  it('ping délègue', async () => {
    client.ping.mockResolvedValue('PONG');
    await expect(service.ping()).resolves.toBe('PONG');
  });

  it('onModuleDestroy ferme la connexion (quit borné + disconnect)', async () => {
    await service.onModuleDestroy();
    expect(client.quit).toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('onModuleDestroy ne throw pas si quit rejette (force disconnect)', async () => {
    client.quit.mockRejectedValue(new Error('Connection is closed'));
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(client.disconnect).toHaveBeenCalled();
  });
});
