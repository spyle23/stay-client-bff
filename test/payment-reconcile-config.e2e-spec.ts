import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { resolveReconcileOptions } from '../src/modules/payment/reconcile.constants';

/**
 * Configuration de la réconciliation (#5 AC-8) **au démarrage réel** d'`AppModule` :
 * - une valeur hors bornes empêche le BFF de démarrer (pas seulement la fonction pure) ;
 * - sous `NODE_ENV=test`, aucune passe n'est planifiée ; un interrupteur explicite la planifie ;
 * - `.env.example` documente les six variables, avec les défauts de la spécification.
 */
const INTERVAL_NAME = 'payment-reconciler';

const RECONCILE_VARS = [
  'PAYMENT_RECONCILE_ENABLED',
  'PAYMENT_RECONCILE_INTERVAL_MS',
  'PAYMENT_RECONCILE_BATCH',
  'PAYMENT_RECONCILE_ALERT_AFTER_SECONDS',
  'PAYMENT_RECONCILE_ALERT_REPEAT_SECONDS',
  'PAYMENT_RECONCILE_MAX_AGE_SECONDS',
] as const;

describe('payment/reconcile — configuration au démarrage (e2e, #5 AC-8)', () => {
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication | undefined;

  beforeAll(() => {
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    process.env.SERVICE_KEY =
      process.env.SERVICE_KEY ?? 'e2e-service-key-config';
  });

  beforeEach(() => {
    for (const name of RECONCILE_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    app = undefined;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    for (const name of RECONCILE_VARS) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  async function boot(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const created = moduleRef.createNestApplication();
    await created.init();
    return created;
  }

  it('sous NODE_ENV=test, sans interrupteur : aucune passe planifiée', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    app = await boot();
    const scheduler = app.get(SchedulerRegistry);
    expect(scheduler.doesExist('interval', INTERVAL_NAME)).toBe(false);
  });

  it('interrupteur explicite : passe planifiée, retirée à l’arrêt', async () => {
    process.env.PAYMENT_RECONCILE_ENABLED = 'true';
    process.env.PAYMENT_RECONCILE_INTERVAL_MS = '600000';
    app = await boot();
    const scheduler = app.get(SchedulerRegistry);
    expect(scheduler.doesExist('interval', INTERVAL_NAME)).toBe(true);
    await app.close();
    app = undefined;
    expect(scheduler.doesExist('interval', INTERVAL_NAME)).toBe(false);
  });

  it.each([
    ['PAYMENT_RECONCILE_INTERVAL_MS', '9999'],
    ['PAYMENT_RECONCILE_INTERVAL_MS', '600001'],
    ['PAYMENT_RECONCILE_ENABLED', 'peut-etre'],
    ['PAYMENT_RECONCILE_MAX_AGE_SECONDS', 'huit-jours'],
  ])('%s=%s : le BFF refuse de démarrer', async (name, value) => {
    process.env[name] = value;
    await expect(boot()).rejects.toThrow(new RegExp(name));
  });

  it('.env.example documente les six variables avec les défauts de la spécification', () => {
    const example = readFileSync(join(__dirname, '..', '.env.example'), 'utf8');
    const documented: Record<string, string> = {};
    for (const name of RECONCILE_VARS) {
      const match = new RegExp(`^${name}=(.*)$`, 'm').exec(example);
      expect(match).not.toBeNull();
      documented[name] = (match as RegExpExecArray)[1].trim();
    }
    expect(documented).toEqual({
      PAYMENT_RECONCILE_ENABLED: 'true',
      PAYMENT_RECONCILE_INTERVAL_MS: '60000',
      PAYMENT_RECONCILE_BATCH: '50',
      PAYMENT_RECONCILE_ALERT_AFTER_SECONDS: '900',
      PAYMENT_RECONCILE_ALERT_REPEAT_SECONDS: '3600',
      PAYMENT_RECONCILE_MAX_AGE_SECONDS: '691200',
    });
    // Les valeurs documentées sont acceptées telles quelles et égales aux défauts du code.
    expect(resolveReconcileOptions({ ...documented })).toEqual(
      resolveReconcileOptions({}),
    );
  });
});
