import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Sécurité : en-têtes HTTP durcis (dépendance helmet requise par le socle).
  app.use(helmet());
  // CORS : le front (origine distincte :3000) doit pouvoir appeler le BFF avec cookies de session.
  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  });
  // Préfixe d'API versionné — le contrat front cible /api/v1 (cf. .env.example / docker-compose).
  app.setGlobalPrefix('api/v1');
  // Port par défaut 4000 (le front occupe 3000) — cf. .env.example / docker-compose.
  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
