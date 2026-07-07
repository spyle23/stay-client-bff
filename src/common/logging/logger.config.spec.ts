import pino from 'pino';
import { correlationStorage } from '../correlation/correlation.context';
import {
  pinoHttpOptions,
  redactedReqSerializer,
  redactOptions,
  REDACTED_PATHS,
} from './logger.config';

describe('logger redaction', () => {
  it('déclare les chemins sensibles (carte/JWT/cookie/clientSecret/password)', () => {
    expect(REDACTED_PATHS).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        '*.clientSecret',
        '*.password',
      ]),
    );
  });

  it('masque effectivement les valeurs sensibles dans la sortie JSON', () => {
    const lines: string[] = [];
    const stream: pino.DestinationStream = {
      write: (s: string) => {
        lines.push(s);
      },
    };
    const logger = pino({ redact: redactOptions, base: null }, stream);

    logger.info(
      {
        req: {
          headers: { authorization: 'Bearer super-secret', cookie: 'sid=abc' },
        },
        payment: { clientSecret: 'sk_live_XYZ' },
        user: { password: 'p@ssw0rd' },
      },
      'requête test',
    );

    const out = lines.join('');
    expect(out).toContain('[Redacted]');
    expect(out).not.toContain('super-secret');
    expect(out).not.toContain('sk_live_XYZ');
    expect(out).not.toContain('p@ssw0rd');
  });

  it("genReqId et customProps portent le correlationId depuis l'ALS", () => {
    correlationStorage.run({ correlationId: 'cid-123' }, () => {
      expect(pinoHttpOptions.genReqId()).toBe('cid-123');
      expect(pinoHttpOptions.customProps()).toEqual({
        correlationId: 'cid-123',
      });
    });
  });

  it('le serializer req retire la query-string (secrets potentiels) et masque les en-têtes sensibles', () => {
    const serialized = redactedReqSerializer({
      method: 'GET',
      url: '/api/v1/reset?token=super-secret-token&code=abc',
      headers: {
        authorization: 'Bearer jwt',
        cookie: 'sid=1',
        host: 'localhost',
        'user-agent': 'jest',
      },
    });
    expect(serialized.url).toBe('/api/v1/reset?[Redacted]');
    expect(JSON.stringify(serialized)).not.toContain('super-secret-token');
    expect(serialized.headers).not.toHaveProperty('authorization');
    expect(serialized.headers).not.toHaveProperty('cookie');
    expect(serialized.headers.host).toBe('localhost');
  });
});
