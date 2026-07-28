import { Module } from '@nestjs/common';
import { PmsModule } from '../../integration/pms/pms.module';
import { CATALOG_OPTIONS, resolveCatalogOptions } from './catalog.constants';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

/**
 * Module `catalog` (story 1.9, FR-5) — page hôtel publique. Importe la frontière PMS (`PmsModule`) ;
 * `RedisService` et `CorrelationService` sont globaux (injectés sans réimport).
 *
 * `CatalogService` est **exporté** (story 2.2) : le devis du tunnel (`BookingModule`) le compose
 * au lieu d'ouvrir un second chemin d'accès au PMS — c'est ce qui garantit que le total du
 * récapitulatif ne peut pas diverger de celui de la fiche chambre.
 */
@Module({
  imports: [PmsModule],
  controllers: [CatalogController],
  providers: [
    { provide: CATALOG_OPTIONS, useFactory: () => resolveCatalogOptions() },
    CatalogService,
  ],
  exports: [CatalogService],
})
export class CatalogModule {}
