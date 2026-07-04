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
| `yarn test:e2e` | Tests end-to-end |

## Structure

- `src/modules/{auth,search,catalog,booking,payment,account,consent,health}` — modules métier
  (coquilles à implémenter au fil des stories).
- `src/{config,common,redis,integration/pms}` — infrastructure transverse.
- `src/types/generated` — types générés depuis l'OpenAPI du PMS (story 1.2).

Architecture détaillée : voir `docs/` à la racine du monorepo.
