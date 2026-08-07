import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { correlationMiddleware } from './common/correlation/correlation.middleware';
import { resolveTrustProxy } from './common/throttler/throttler.constants';

async function bootstrap() {
  // bufferLogs : les logs de boot sont mis en tampon puis rejoués par pino une fois prêt.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  // `trust proxy` (story 2.4) : commande la valeur de `req.ip`, sur laquelle repose la limitation
  // de débit par adresse (NFR-7). Défaut `false` — voir `resolveTrustProxy` : les deux erreurs
  // possibles (activé sans proxy / désactivé derrière un proxy) sont graves et opposées, il n'y a
  // donc pas de valeur universellement sûre. À poser explicitement au déploiement.
  //
  // Deux garde-fous au boot, ici et pas plus tard : une valeur invalide **arrête** le démarrage en
  // nommant `TRUST_PROXY` (sinon `proxy-addr` lève un `TypeError: invalid IP address` anonyme à la
  // première requête), et une variable absente en production produit un log `error` explicite.
  app.set('trust proxy', resolveTrustProxy());
  // Corrélation-id EN PREMIER — englobe la journalisation pino et tous les handlers.
  app.use(correlationMiddleware);
  // Journalisation via pino (logs Nest routés vers pino : JSON structuré + redaction).
  app.useLogger(app.get(Logger));
  // Sécurité : en-têtes HTTP durcis (dépendance helmet requise par le socle).
  app.use(helmet());
  // CORS : le front cliente (origine distincte **:3001** — :3000 est le back-office Stay) doit
  // pouvoir appeler le BFF avec le cookie de session. ⚠️ Avec `credentials: true` + cookie
  // HttpOnly, une origine erronée casse la session **silencieusement** (le navigateur rejette la
  // réponse sans erreur applicative) : le défaut doit donc pointer le vrai front cliente.
  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:3001',
    credentials: true,
  });
  // /health et /health/live hors du préfixe versionné (sondes infra Docker/k8s) ; le reste sous /api/v1.
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/live'] });
  // Arrêt gracieux : SIGTERM/SIGINT → cycle de shutdown Nest → onModuleDestroy (quit Redis).
  app.enableShutdownHooks();
  // Port par défaut 4000 (le front occupe 3000) — cf. .env.example / docker-compose.
  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
