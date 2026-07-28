import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import { getCorrelationId } from '../correlation/correlation.context';

/**
 * Chemins **masqués** dans les logs (NFR-11 / NFR-6) : aucune donnée de carte, aucun JWT /
 * `Authorization`, aucun cookie, aucun `clientSecret`, aucun mot de passe en clair.
 *
 * ⚠️ `*.x` masque `<clé>.x` sur **UN seul niveau intermédiaire** (pino/fast-redact ne supporte
 * pas de wildcard récursif `**`). Un secret imbriqué plus profond nécessiterait un serializer
 * dédié — reporté au durcissement sécurité (Epic 6, cf. deferred-work).
 */
export const REDACTED_PATHS = [
  // Requête : en-têtes sensibles (défense — le serializer `req` ne journalise déjà qu'une whitelist).
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-service-key"]',
  // Réponse : en-têtes sensibles éventuels.
  'res.headers["set-cookie"]',
  'res.headers.authorization',
  'res.headers["x-service-key"]',
  // Logs applicatifs manuels (objets métier) — un niveau d'imbrication.
  '*.authorization',
  '*.password',
  '*.newPassword',
  // Mot de passe généré du compte léger invité (story 2.3) : `register/customer` exige les DEUX
  // champs — masquer `password` seul laisserait le secret en clair sous `confirmPassword`.
  '*.confirmPassword',
  // Jetons de session (story 2.1) : la custody garde les JWT côté serveur — ils ne doivent
  // pas non plus fuir par les logs. ⚠️ Un seul niveau : ne JAMAIS logger l'objet session
  // entier (`session.accessToken` serait masqué, `x.session.accessToken` non).
  '*.accessToken',
  '*.refreshToken',
  '*.clientSecret',
  '*.cardNumber',
  '*.card',
  '*.cvc',
  '*.pan',
];

/** Configuration de redaction (partagée : LoggerModule + test de redaction). */
export const redactOptions = {
  paths: REDACTED_PATHS,
  censor: '[Redacted]',
};

interface SerializableReq {
  id?: unknown;
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  remoteAddress?: string;
  socket?: { remoteAddress?: string };
}

/**
 * Serializer `req` sûr : **retire la query-string** (peut contenir des secrets : magic-link,
 * reset, code OAuth) et ne journalise qu'une **whitelist** d'en-têtes non sensibles
 * (jamais `authorization`/`cookie`/`x-service-key`).
 */
export function redactedReqSerializer(req: SerializableReq) {
  const url = typeof req.url === 'string' ? req.url : '';
  const qIndex = url.indexOf('?');
  const headers = req.headers ?? {};
  return {
    id: req.id,
    method: req.method,
    url: qIndex >= 0 ? `${url.slice(0, qIndex)}?[Redacted]` : url,
    headers: {
      host: headers.host,
      'user-agent': headers['user-agent'],
      'content-type': headers['content-type'],
      'content-length': headers['content-length'],
    },
    remoteAddress: req.remoteAddress ?? req.socket?.remoteAddress,
  };
}

/**
 * Options `pino` partagées. `satisfies` valide la compatibilité avec `nestjs-pino`
 * tout en conservant le type concret (le test accède à `redact`).
 */
export const pinoHttpOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  // Le reqId de pino = le corrélation-id (posé par correlationMiddleware, actif ici).
  genReqId: () => getCorrelationId() ?? randomUUID(),
  // Champ explicite `correlationId` sur chaque ligne de log.
  customProps: () => ({ correlationId: getCorrelationId() }),
  serializers: { req: redactedReqSerializer },
  redact: redactOptions,
} satisfies Params['pinoHttp'];
