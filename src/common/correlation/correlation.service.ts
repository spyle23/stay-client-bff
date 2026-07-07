import { Injectable } from '@nestjs/common';
import { getCorrelationId } from './correlation.context';

/**
 * Accès injectable au corrélation-id de la requête courante. Les services (health,
 * futurs appelants du PMS) l'utilisent pour propager `X-Correlation-ID` jusqu'au PMS.
 */
@Injectable()
export class CorrelationService {
  getCorrelationId(): string | undefined {
    return getCorrelationId();
  }
}
