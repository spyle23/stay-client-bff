import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import type { RoomDetailDto } from '../catalog/dto/room-detail.dto';
import { BOOKING_OPTIONS, type BookingOptions } from './booking.constants';
import type {
  BookingQuoteDto,
  CancellationPolicyDto,
} from './dto/booking-quote.dto';
import type { BookingQuoteQueryDto } from './dto/booking-quote.query.dto';

/**
 * Domaine `booking` (story 2.2, FR-7) — **devis du récapitulatif avant paiement**.
 *
 * Strictement **en lecture** : aucune écriture PMS, aucun `X-Service-Key`, aucune vérité métier
 * durable côté BFF (AR-6, AR-13, FR-21). La création de la Réservation `Pending` (et le Hold de
 * checkout) est le périmètre de la story 2.4.
 *
 * **Anti-réinvention (décision de la story)** : le devis **délègue** la composition à
 * `CatalogService.getRoomDetail` — déjà résilient, déjà caché, déjà porteur du cross-check de
 * disponibilité datée. C'est ce qui garantit *mécaniquement* que le total du récapitulatif ne peut
 * pas diverger d'un centime de celui de la fiche chambre (AC-1). Toute composition PMS parallèle
 * réintroduirait deux vérités de prix.
 *
 * **Fraîcheur assumée (Décision 2 de la story)** : `getRoomDetail` sert son cache Redis quand il
 * est chaud — le cross-check de disponibilité n'est donc **pas** rejoué à chaque devis, et la
 * disponibilité affichée peut dater du TTL `catalog`. C'est un choix : un second cache créerait
 * deux vérités de prix. La disponibilité **faisant foi** est celle de la création atomique de la
 * story 2.4 (D3/AR-18) — cet écran ne la remplace pas. Atténuation en place : une réponse
 * dégradée n'est jamais mise en cache.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly catalog: CatalogService,
    @Inject(BOOKING_OPTIONS) private readonly options: BookingOptions,
  ) {}

  /**
   * Devis pour (hôtel, chambre, dates, voyageurs). Propage tel quel un `PmsRequestError` 404
   * (hôtel/chambre introuvable) et un `PmsUnavailableError` (503) — le filtre global les mappe.
   */
  async getQuote(query: BookingQuoteQueryDto): Promise<BookingQuoteDto> {
    // Borne de durée vérifiée AVANT toute I/O : les dates sont déjà validées (format, ordre,
    // non-passé) par le DTO, donc le nombre de nuits est calculable sans le PMS. La rejeter après
    // la composition ferait partir trois appels PMS — et cacher le résultat — pour une query que
    // l'on savait invalide dès sa lecture (revue 2.2).
    this.assertStayWithinBounds(query.checkInDate, query.checkOutDate);

    const room = await this.catalog.getRoomDetail(query.hotelId, query.roomId, {
      checkInDate: query.checkInDate,
      checkOutDate: query.checkOutDate,
      guests: query.guests,
    });

    const nights = this.resolveNights(room);
    // Formule UNIQUE du total : dérivée des unités mineures déjà arrondies, exactement comme
    // `CatalogService.toRoomDetailDto`. Le total affiché reste ainsi cohérent avec le prix/nuit
    // affiché (un double arrondi depuis le décimal les ferait diverger d'un cent).
    const roomTotal = room.pricePerNight * nights;
    this.assertCatalogTotalCoherence(room, nights, roomTotal);

    return {
      hotelId: room.hotelId,
      hotelName: room.hotelName,
      hotelCity: room.hotelCity,
      // AC-1 énumère le logo de l'Hôtel : `catalog` le réexpose désormais sur la fiche chambre
      // (revue 2.2 — il était figé à `null` ici alors que le PMS le fournit). `null` reste possible
      // pour un établissement qui n'en publie pas : le front rend alors le nom seul.
      hotelLogoUrl: room.hotelLogoUrl,

      roomId: room.id,
      roomNumber: room.number,
      roomCategory: room.category,
      roomCapacity: room.capacity,
      roomImageUrl: room.images[0]?.url ?? null,

      checkInDate: query.checkInDate,
      checkOutDate: query.checkOutDate,
      nights,
      guests: query.guests,

      currency: room.currency,
      pricePerNight: room.pricePerNight,
      roomTotal,
      taxAmount: null,
      taxState: 'included_undetailed',
      total: roomTotal,

      available: room.available,
      availabilityDegraded: room.availabilityDegraded,

      cancellationPolicy: buildCancellationPolicy(),

      // Horodatage de **composition** du devis, pas de fraîcheur de la donnée : `catalog` peut
      // avoir servi une entrée de cache (Décision 2 de la story). Ne pas s'en servir pour
      // afficher « prix vérifié à HH:MM » — ce serait affirmer une fraîcheur non garantie.
      quotedAt: new Date().toISOString(),
    };
  }

  /**
   * Rejette un séjour hors bornes **avant** d'appeler le PMS. Les dates arrivent déjà validées par
   * le DTO (`AAAA-MM-JJ`, ordonnées, arrivée non passée) : la durée s'en déduit sans I/O.
   */
  private assertStayWithinBounds(
    checkInDate: string,
    checkOutDate: string,
  ): void {
    const checkIn = Date.parse(`${checkInDate}T00:00:00Z`);
    const checkOut = Date.parse(`${checkOutDate}T00:00:00Z`);
    if (Number.isNaN(checkIn) || Number.isNaN(checkOut)) {
      return;
    }
    const nights = Math.round((checkOut - checkIn) / 86_400_000);
    if (nights > this.options.maxStayNights) {
      throw new BadRequestException(
        `La durée du séjour dépasse le maximum autorisé (${this.options.maxStayNights} nuits).`,
      );
    }
  }

  /**
   * Nuits du séjour, **obligatoires** pour un devis.
   *
   * ⚠️ Piège réel : `getRoomDetail` **écarte silencieusement** un contexte de dates qu'il juge
   * inutilisable (passé, incohérent, ou séjour au-delà de `CATALOG_MAX_STAY_NIGHTS`) et retombe sur
   * un affichage prix/nuit (`nights: null`). Ce repli est correct pour une page publique, mais un
   * récapitulatif à total `null` n'a aucun sens : on refuse explicitement en 400 plutôt que de
   * rendre un devis vide. La borne propre au module est re-vérifiée (elle peut être plus stricte
   * que celle de `catalog`).
   */
  private resolveNights(room: RoomDetailDto): number {
    if (room.nights === null || room.totalPrice === null || room.nights <= 0) {
      throw new BadRequestException(
        'Les dates de séjour ne sont pas exploitables pour un devis.',
      );
    }
    if (room.nights > this.options.maxStayNights) {
      throw new BadRequestException(
        `La durée du séjour dépasse le maximum autorisé (${this.options.maxStayNights} nuits).`,
      );
    }
    return room.nights;
  }

  /**
   * Filet de non-régression sur le contrat `catalog` : le total de la fiche chambre **doit** être
   * `pricePerNight × nights`. Une divergence signifierait que la fiche chambre et le récapitulatif
   * annoncent deux montants différents pour le même séjour (AC-1 rompu) — on garde la formule comme
   * source de vérité et on rend l'écart visible plutôt que silencieux.
   */
  private assertCatalogTotalCoherence(
    room: RoomDetailDto,
    nights: number,
    roomTotal: number,
  ): void {
    if (room.totalPrice !== null && room.totalPrice !== roomTotal) {
      this.logger.warn(
        `Total incohérent avec la fiche chambre ${room.id} (hôtel ${room.hotelId}) : ` +
          `catalog=${room.totalPrice}, devis=${roomTotal} (${room.pricePerNight} × ${nights} ${room.currency}).`,
      );
    }
  }
}

/**
 * Politique d'annulation — **SEUL point de bascule** le jour où D2 (AR-17) sera livré.
 *
 * Le PMS n'expose aujourd'hui aucune politique par hôtel (`Hotel` n'a ni règle, ni délai, ni taux
 * de remboursement). Le repli ne remplit donc **aucun** champ de détail : afficher « annulation
 * gratuite jusqu'au … » sans donnée serait une promesse fausse (UX-DR-9.5). Le front rend un texte
 * générique honnête à partir de `source === 'fallback'`.
 */
function buildCancellationPolicy(): CancellationPolicyDto {
  return {
    source: 'fallback',
    refundable: null,
    freeUntil: null,
    terms: null,
  };
}
