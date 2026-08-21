import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  CurrentSession,
  type RequestSession,
} from '../../common/decorators/current-session.decorator';
import { SessionGuard } from '../../common/guards/session.guard';
import { RESERVATION_THROTTLE } from '../../common/throttler/throttler.constants';
import type { ApiResponse } from '../../integration/pms/api-response.types';
import { BookingService } from './booking.service';
import type { BookingQuoteDto } from './dto/booking-quote.dto';
import { BookingQuoteQueryDto } from './dto/booking-quote.query.dto';
import { CreateReservationRequestDto } from './dto/create-reservation.request.dto';
import type { BookingReservationDto } from './dto/reservation.dto';
import {
  ReplaceReservationServicesRequestDto,
  type UpsellCatalogDto,
} from './dto/upsell-service.dto';
import { UpsellQueryDto } from './dto/upsell.query.dto';

/**
 * Frontière HTTP du domaine `booking` (tunnel de réservation) :
 * - `GET  /api/v1/booking/quote` — devis du récapitulatif avant paiement (story 2.2, FR-7) ;
 * - `POST /api/v1/booking/reservations` — création de la Réservation `Pending` (story 2.4, FR-9) ;
 * - `GET  /api/v1/booking/reservations/:id` — reprise sans perte du tunnel (story 2.4, AC-9).
 *
 * **`/quote` est publique, volontairement non gardée.** L'identification est l'étape suivante et
 * l'inscription n'est **jamais** forcée avant de réserver (UX-DR-9.6, UX-DR-3.12) : exiger une
 * session ici transformerait le récapitulatif en mur de connexion. Aucune donnée personnelle n'est
 * exposée — uniquement des informations publiques d'hôtel/chambre déjà servies par `catalog`.
 *
 * **Les deux routes `reservations` sont gardées** : ce sont la première écriture métier et sa
 * relecture. Un 401 renvoie le voyageur à l'étape d'identification, jamais vers une inscription.
 *
 * Réexpose l'enveloppe `ApiResponse<T>` **à l'identique** (l'`api-client` du front la lit tel quel).
 * Hôtel/chambre introuvable → **404** ; dates inexploitables → **400** ; panne PMS → **503** (via
 * le filtre d'exceptions global).
 */
@Controller('booking')
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Get('quote')
  async getQuote(
    @Query() query: BookingQuoteQueryDto,
  ): Promise<ApiResponse<BookingQuoteDto>> {
    return {
      success: true,
      data: await this.bookingService.getQuote(query),
    };
  }

  /**
   * Crée la Réservation `Pending` — **201** à la création réelle, **200** sur rejeu idempotent.
   *
   * L'ordre des gardes compte : `SessionGuard` d'abord (il pose `clientSession`, dont le traceur
   * d'identité du limiteur a besoin), `ThrottlerGuard` ensuite.
   *
   * Le statut varie selon `created` : la distinction est **observable** par le front et par les
   * tests (« un rejeu n'a rien créé »), là où un 201 systématique la masquerait.
   *
   * ⚠️ **Politique de débit explicite** (`RESERVATION_THROTTLE`) plutôt qu'héritée des limiteurs
   * globaux : le seuil d'**identité** y est relevé (plafonné au seuil IP) parce que le guard compte
   * **avant** que le service ne reconnaisse un rejeu idempotent — un double-clic, un F5 ou un
   * retour arrière, qui n'écrivent rien (AC-5), consommaient sinon le quota du voyageur au pire
   * moment du tunnel. La protection réelle de l'écriture reste le seuil par IP, le verrou de
   * séjour et l'idempotence côté service.
   */
  @Post('reservations')
  @UseGuards(SessionGuard, ThrottlerGuard)
  @Throttle(RESERVATION_THROTTLE)
  async createReservation(
    @CurrentSession() session: RequestSession,
    @Body() body: CreateReservationRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<BookingReservationDto>> {
    noStore(res);
    const reservation = await this.bookingService.createReservation(
      session,
      body,
    );
    res.status(reservation.created ? HttpStatus.CREATED : HttpStatus.OK);
    return { success: true, data: reservation };
  }

  /**
   * Catalogue d'upsell du séjour (story 2.6, AC-1/AC-2).
   *
   * **Gardé** : le catalogue de services d'un hôtel est `[RequireRole(Manager, Customer)]` côté PMS
   * et l'upsell n'a de sens qu'une fois le voyageur dans le tunnel. Exposer cette lecture
   * publiquement relèverait de la dépendance D9 (page hôtel SEO), qui n'est pas livrée.
   */
  @Get('services')
  @UseGuards(SessionGuard)
  async getUpsellServices(
    @CurrentSession() session: RequestSession,
    @Query() query: UpsellQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<UpsellCatalogDto>> {
    noStore(res);
    return {
      success: true,
      data: await this.bookingService.getUpsellServices(session, query),
    };
  }

  /**
   * Remplace le panier de services d'une Réservation `Pending` (story 2.6, AC-5).
   *
   * Sémantique **replace** : le tableau envoyé devient le panier complet, un tableau vide retire
   * tout. Refusé par le PMS dès qu'un paiement est engagé — traduit ici en motif métier
   * (`services-locked`), jamais en 503.
   */
  @Put('reservations/:id/services')
  @UseGuards(SessionGuard)
  async replaceReservationServices(
    @CurrentSession() session: RequestSession,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ReplaceReservationServicesRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<BookingReservationDto>> {
    noStore(res);
    return {
      success: true,
      data: await this.bookingService.replaceServices(session, id, body),
    };
  }

  /**
   * Relit une réservation du tunnel (reprise après rafraîchissement ou retour arrière).
   *
   * `ParseUUIDPipe` avant tout appel : un identifiant libre serait interpolé tel quel dans le
   * chemin PMS (même garde que `catalog.controller.ts`).
   */
  @Get('reservations/:id')
  @UseGuards(SessionGuard)
  async getReservation(
    @CurrentSession() session: RequestSession,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<BookingReservationDto>> {
    noStore(res);
    return {
      success: true,
      data: await this.bookingService.getReservation(session, id),
    };
  }
}

/**
 * Réponse liée à une session (réservation d'un voyageur identifié) : sans directive, un cache
 * partagé (proxy d'entreprise, CDN) pourrait la resservir à un autre visiteur.
 */
function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Vary', 'Cookie');
}
