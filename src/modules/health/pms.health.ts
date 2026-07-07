import { Injectable } from '@nestjs/common';
import {
  type HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import axios from 'axios';
import { getCorrelationId } from '../../common/correlation/correlation.context';

/**
 * Indicateur de joignabilité du PMS : sonde active bornée (3 s). Toute réponse HTTP
 * — **même 401** — prouve la joignabilité (les endpoints PMS sont authentifiés) ; seule
 * une erreur réseau / un timeout signale « down ». Propage le corrélation-id (NFR-11).
 */
@Injectable()
export class PmsHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    // `||` (pas `??`) pour traiter PMS_BASE_URL="" comme absent.
    const baseUrl = process.env.PMS_BASE_URL || 'http://localhost:5231/api/v1';
    const timeoutMs = Number(process.env.PMS_TIMEOUT_MS) || 8000;
    const headers: Record<string, string> = {};
    const correlationId = getCorrelationId();
    if (correlationId) {
      headers['X-Correlation-ID'] = correlationId;
    }
    try {
      await axios.get(baseUrl, {
        timeout: timeoutMs,
        validateStatus: () => true,
        maxRedirects: 0, // une redirection 3xx ne prouve pas la joignabilité DU PMS
        maxContentLength: 64 * 1024, // sonde : borne le corps téléchargé
        headers,
      });
      return indicator.up();
    } catch (err) {
      return indicator.down({
        message: err instanceof Error ? err.message : 'PMS injoignable',
      });
    }
  }
}
