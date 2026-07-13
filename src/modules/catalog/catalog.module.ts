import { Module } from '@nestjs/common';
import { PmsModule } from '../../integration/pms/pms.module';
import { CATALOG_OPTIONS, resolveCatalogOptions } from './catalog.constants';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

/**
 * Module `catalog` (story 1.9, FR-5) — page hôtel publique. Importe la frontière PMS (`PmsModule`) ;
 * `RedisService` et `CorrelationService` sont globaux (injectés sans réimport).
 */
@Module({
  imports: [PmsModule],
  controllers: [CatalogController],
  providers: [
    { provide: CATALOG_OPTIONS, useFactory: () => resolveCatalogOptions() },
    CatalogService,
  ],
})
export class CatalogModule {}
