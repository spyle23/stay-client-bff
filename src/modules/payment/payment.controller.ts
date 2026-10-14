import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CurrentSession,
  type RequestSession,
} from '../../common/decorators/current-session.decorator';
import { SessionGuard } from '../../common/guards/session.guard';
import type { ApiResponse } from '../../integration/pms/api-response.types';
import type { ConfirmationProofDto } from './dto/confirmation-proof.dto';
import type { PaymentIntentDto } from './dto/payment-intent.dto';
import { PaymentService } from './payment.service';

/**
 * Frontière HTTP du domaine `payment` (story 3.1, FR-12) :
 * - `POST /api/v1/payment/reservations/:id/intent` — émet le PaymentIntent en **capture manuelle** ;
 * - `POST /api/v1/payment/reservations/:id/confirm` — confirmation ferme et preuve (story 3.2).
 *
 * **Gardée** : c'est une écriture engageant l'argent du voyageur, et le PMS exige le JWT `Customer`.
 * Un 401 renvoie à l'étape d'identification, jamais vers une inscription (UX-DR-9.6).
 *
 * `POST` et non `GET` malgré l'apparence de lecture : l'appel **a des effets** — il gèle le balayeur
 * de holds (`paymentStarted`) et fait créer un PaymentIntent chez Stripe. Un `GET` serait
 * préchargeable par le navigateur et rejouable par un cache.
 *
 * Réexpose l'enveloppe `ApiResponse<T>` **à l'identique** (l'`api-client` du front la lit tel quel).
 */
@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  /**
   * **200, jamais 201.** Contrairement à `POST /booking/reservations` — qui distingue création et
   * rejeu idempotent — le BFF ignore ici si le PMS a **créé** un PaymentIntent ou **réutilisé**
   * celui de la réservation : sa réponse ne le dit pas. Renvoyer 201 affirmerait une création que
   * rien ne permet de vérifier, et le rejeu (le cas le plus fréquent : double clic, F5) mentirait.
   *
   * `ParseUUIDPipe` avant tout appel : un identifiant libre serait interpolé tel quel dans un
   * chemin PMS (même garde que `booking.controller.ts` et `catalog.controller.ts`).
   */
  @Post('reservations/:id/intent')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  async createIntent(
    @CurrentSession() session: RequestSession,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<PaymentIntentDto>> {
    noStore(res);
    return {
      success: true,
      data: await this.paymentService.createIntent(session, id),
    };
  }

  /**
   * Confirmation ferme post-paiement (story 3.2, FR-13) : le PMS capture la retenue puis confirme ;
   * la réponse est la **preuve** (code, récapitulatif, montant encaissé), sans PII ni jeton.
   *
   * **200, jamais 201** — même raison qu'à l'intent : le BFF ignore si le PMS vient de confirmer ou
   * rejoue une confirmation déjà faite (rechargement, second onglet).
   */
  @Post('reservations/:id/confirm')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionGuard)
  async confirm(
    @CurrentSession() session: RequestSession,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<ConfirmationProofDto>> {
    noStore(res);
    return {
      success: true,
      data: await this.paymentService.confirm(session, id),
    };
  }
}

/**
 * Réponse liée à une session ET porteuse d'un `clientSecret` à portée d'un seul PaymentIntent :
 * sans directive, un cache partagé (proxy d'entreprise, CDN) pourrait la resservir à un autre
 * visiteur — qui se retrouverait à confirmer le paiement de quelqu'un d'autre.
 */
function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Vary', 'Cookie');
}
