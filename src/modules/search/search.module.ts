import { Module } from '@nestjs/common';
import { PmsModule } from '../../integration/pms/pms.module';
import { resolveSearchOptions, SEARCH_OPTIONS } from './search.constants';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/**
 * Module de recherche multi-hôtels (FR-1/FR-4). Importe la frontière PMS (`PmsModule`) ;
 * `RedisService` et `CorrelationService` sont globaux (injectés sans réimport).
 */
@Module({
  imports: [PmsModule],
  controllers: [SearchController],
  providers: [
    { provide: SEARCH_OPTIONS, useFactory: () => resolveSearchOptions() },
    SearchService,
  ],
})
export class SearchModule {}
