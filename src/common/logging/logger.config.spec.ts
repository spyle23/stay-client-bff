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

  it('masque les jetons de session et le Set-Cookie (custody — story 2.1, AC-6)', () => {
    const lines: string[] = [];
    const stream: pino.DestinationStream = {
      write: (s: string) => {
        lines.push(s);
      },
    };
    const logger = pino({ redact: redactOptions, base: null }, stream);

    logger.info(
      {
        res: { headers: { 'set-cookie': 'stay_sid=abc.def; HttpOnly' } },
        // Objet à UN niveau : la forme sous laquelle du code applicatif logguerait une session.
        session: { accessToken: 'eyJhbGciOi.PAYLOAD', refreshToken: 'r3fr3sh' },
      },
      'auth test',
    );

    const out = lines.join('');
    expect(out).not.toContain('eyJhbGciOi.PAYLOAD');
    expect(out).not.toContain('r3fr3sh');
    expect(out).not.toContain('stay_sid=abc.def');
  });

  it('ne masque PAS au-delà d’un niveau d’imbrication — ne jamais logger un objet session imbriqué', () => {
    // Garde-fou explicite : `fast-redact` ne supporte pas de wildcard récursif. Ce test fige la
    // limite connue pour qu'elle ne soit pas prise à tort pour une protection générale.
    const lines: string[] = [];
    const stream: pino.DestinationStream = {
      write: (s: string) => {
        lines.push(s);
      },
    };
    const logger = pino({ redact: redactOptions, base: null }, stream);

    logger.info({ ctx: { session: { accessToken: 'FUITE-2-NIVEAUX' } } }, 'x');

    expect(lines.join('')).toContain('FUITE-2-NIVEAUX');
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
