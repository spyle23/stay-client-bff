/**
 * Génération des types PMS depuis le snapshot OpenAPI de Stay-api.
 *
 * Exécuter avec : `yarn gen:types` (utilise `tsx`).
 * Source     : openapi/stay-api.json — snapshot de `GET /swagger/v1/swagger.json`
 *              (le Swagger de Stay-api n'est exposé qu'en environnement Development, port 5231).
 * Sortie     : src/types/generated/pms.ts — FICHIER GÉNÉRÉ, jamais édité à la main (AR-4).
 *
 * Rafraîchir le snapshot quand le contrat PMS change :
 *   1. Lancer Stay-api en Development (Postgres requis) → http://localhost:5231
 *   2. curl http://localhost:5231/swagger/v1/swagger.json -o openapi/stay-api.json
 *   3. yarn gen:types
 *
 * La CI ne régénère pas (aucun PMS en CI) ; elle type-check le pms.ts commité.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const here = dirname(fileURLToPath(import.meta.url));
const INPUT = new URL('./openapi/stay-api.json', import.meta.url);
const OUTPUT = resolve(here, 'src/types/generated/pms.ts');

const HEADER = `/**
 * FICHIER GÉNÉRÉ — NE PAS ÉDITER À LA MAIN.
 * Types dérivés du contrat OpenAPI du PMS (Stay-api).
 * Régénérer : \`yarn gen:types\` (voir README + openapi-ts.config.ts).
 * Source : openapi/stay-api.json — snapshot de GET /swagger/v1/swagger.json (Swagger dev-only).
 */

`;

async function main(): Promise<void> {
  const ast = await openapiTS(INPUT);
  writeFileSync(OUTPUT, HEADER + astToString(ast), 'utf-8');
  // eslint-disable-next-line no-console
  console.log(`✓ Types PMS generes -> ${OUTPUT}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
