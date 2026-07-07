import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { correlationMiddleware } from './common/correlation/correlation.middleware';

async function bootstrap() {
  // bufferLogs : les logs de boot sont mis en tampon puis rejoués par pino une fois prêt.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // Corrélation-id EN PREMIER — englobe la journalisation pino et tous les handlers.
  app.use(correlationMiddleware);
  // Journalisation via pino (logs Nest routés vers pino : JSON structuré + redaction).
  app.useLogger(app.get(Logger));
  // Sécurité : en-têtes HTTP durcis (dépendance helmet requise par le socle).
  app.use(helmet());
  // CORS : le front (origine distincte :3000) doit pouvoir appeler le BFF avec cookies de session.
  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
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
