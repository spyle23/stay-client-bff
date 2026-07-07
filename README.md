# stay-client-bff

BFF (Backend-for-Frontend) de l'**Application Cliente Stay**, en NestJS 11.
Il expose une API `/api/v1` consommée par `stay-client` (Next.js) et orchestre les appels
vers le PMS `Stay-api`. Le front ne parle **jamais** directement au PMS ; les secrets serveur
(clé de service, secret de session, clés Stripe secrètes) ne transitent jamais par le navigateur.

## Prérequis

- Node.js **20.9+**
- Yarn 1.x
- Redis (custody de session) — cf. `deploy/docker-compose.yml`

## Démarrage

```bash
yarn install
cp .env.example .env    # renseigner les variables
yarn start:dev          # http://localhost:4000/api/v1
```

## Scripts

| Script | Rôle |
|--------|------|
| `yarn build` | Compilation Nest |
| `yarn lint` | ESLint (avec `--fix`, usage local) |
| `yarn lint:ci` | ESLint sans auto-fix (CI) |
| `yarn type-check` | Vérification des types (`tsc --noEmit`) |
| `yarn test` | Tests unitaires (Jest) |
| `yarn test:e2e` | Tests d'intégration / e2e |
| `yarn gen:types` | (Re)génère `src/types/generated/pms.ts` depuis le snapshot OpenAPI |

## Types PMS (OpenAPI)

Les types du contrat PMS vivent dans `src/types/generated/pms.ts`, **générés** depuis
`openapi/stay-api.json` (snapshot commité). Ils ne sont **jamais édités à la main** (AR-4) et
régénérés par dépôt via `yarn gen:types` (config : `openapi-ts.config.ts`).

Le Swagger de Stay-api n'est exposé qu'en environnement **Development** (`http://localhost:5231`).
Pour rafraîchir le snapshot après un changement de contrat PMS :

```bash
# 1. Lancer Stay-api en Development (Postgres requis)
# 2. Capturer le snapshot
curl http://localhost:5231/swagger/v1/swagger.json -o openapi/stay-api.json
# 3. Régénérer les types
yarn gen:types
```

La CI ne régénère pas (aucun PMS en CI) : elle `type-check` le `pms.ts` commité.

## Frontière & résilience PMS

`src/integration/pms/` porte la frontière d'intégration (FR-21) : `PmsClientService`
(client HTTP résilient — timeouts, retries backoff, circuit breaker `opossum`, dégradation
gracieuse, `Idempotency-Key` sur les écritures) et `ServiceKeyProvider` (injecte `X-Service-Key`
**uniquement** sur `/reservations/{id}/confirm`). Réglages via variables d'env (voir `.env.example`).

## Structure

- `src/modules/{auth,search,catalog,booking,payment,account,consent,health}` — modules métier
  (coquilles à implémenter au fil des stories).
- `src/{config,common,redis,integration/pms}` — infrastructure transverse.
- `src/types/generated` — types générés depuis l'OpenAPI du PMS (story 1.2).

Architecture détaillée : voir `docs/` à la racine du monorepo.
