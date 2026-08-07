import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { RequestSession } from '../../common/decorators/current-session.decorator';
import { toMinorUnits } from '../../common/money/minor-units';
import { CorrelationService } from '../../common/correlation/correlation.service';
import type { PmsRequestContext } from '../../integration/pms/pms-client.service';
import { PmsClientService } from '../../integration/pms/pms-client.service';
import { PmsRequestError } from '../../integration/pms/pms-errors';
import type { components } from '../../types/generated/pms';
import { CatalogService } from '../catalog/catalog.service';
import type { RoomDetailDto } from '../catalog/dto/room-detail.dto';
import { SessionService } from '../auth/session.service';
import {
  classifyReservationFailure,
  isPmsGuid,
  PMS_RESERVATION_ENDPOINTS,
  toBookingException,
} from './booking-errors';
import { BOOKING_OPTIONS, type BookingOptions } from './booking.constants';
import {
  CheckoutHoldService,
  type StayFingerprint,
} from './checkout-hold.service';
import type {
  BookingQuoteDto,
  CancellationPolicyDto,
} from './dto/booking-quote.dto';
import type { BookingQuoteQueryDto } from './dto/booking-quote.query.dto';
import type { CreateReservationRequestDto } from './dto/create-reservation.request.dto';
import type {
  BookingReservationDto,
  ReservationStatusName,
} from './dto/reservation.dto';
import type { CommunicationLocale } from './special-requests';

type PmsReservation = components['schemas']['RoomReservationDto'];

/** `PaymentMethod.Stripe` côté PMS (Cash=1, CreditCard=2, BankTransfer=3, Stripe=4, MobileMoney=5). */
const PAYMENT_METHOD_STRIPE = 4;

/** Message unique des ruptures de contrat PMS — jamais de détail technique côté navigateur. */
const BROKEN_CONTRACT_MESSAGE = 'Réponse inattendue du service de réservation.';

/** `ReservationStatus` du PMS → nom exploitable par le front. */
const STATUS_NAMES: Record<number, ReservationStatusName> = {
  1: 'Pending',
  2: 'Confirmed',
  3: 'CheckedIn',
  4: 'CheckedOut',
  5: 'Cancelled',
  6: 'NoShow',
};

/**
 * Domaine `booking` — **tunnel de réservation**.
 *
 * - Story 2.2 (FR-7) : `getQuote`, devis du récapitulatif avant paiement — strictement en lecture.
 * - Story 2.4 (FR-9 / FR-14) : `createReservation` / `getReservation` — **première écriture métier
 *   du produit cliente**, sous session, idempotente, sérialisée et tenue par un Hold de checkout.
 *
 * **Anti-réinvention** : la composition prix/disponibilité **délègue** à
 * `CatalogService.getRoomDetail` — déjà résilient, déjà caché, déjà porteur du cross-check de
 * disponibilité datée. C'est ce qui garantit *mécaniquement* que le total du récapitulatif ne peut
 * pas diverger d'un centime de celui de la fiche chambre (AC-1 de 2.2). Toute composition PMS
 * parallèle réintroduirait deux vérités de prix.
 *
 * **Une seule source de devise** (revue 2.4) : `CatalogService.getHotelCurrency`. La création la
 * lisait auparavant sur la fiche chambre et la relecture sur l'hôtel — deux caches, deux clés, deux
 * TTL. Après un changement de devise côté hôtel, la **même** réservation était donc annoncée avec
 * deux exposants d'unités mineures selon le chemin emprunté (× 100 d'écart entre EUR et MGA). La
 * fiche chambre reste la source du **tarif** ; sa devise n'est plus qu'un contrôle de cohérence.
 *
 * **Fraîcheur assumée (Décision 2 de la story 2.2)** : `getRoomDetail` sert son cache Redis quand
 * il est chaud — la disponibilité affichée peut donc dater du TTL `catalog`. La disponibilité
 * **faisant foi** est celle de la création : `RoomReservationService.CreateAsync` rejoue
 * `IsRoomAvailableAsync` en base au moment de l'écriture. Le pré-contrôle de `createReservation`
 * ne remplace pas cette vérité ; il évite une écriture inutile et **qualifie le motif** (capacité
 * vs indisponibilité), que le PMS confond par ordre de validation.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly catalog: CatalogService,
    private readonly pms: PmsClientService,
    private readonly sessions: SessionService,
    private readonly holds: CheckoutHoldService,
    private readonly correlation: CorrelationService,
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
   * Crée la Réservation `Pending` (story 2.4, FR-9).
   *
   * Séquence, dans cet ordre précis :
   * 1. borne de durée (aucune I/O si le séjour est aberrant) ;
   * 2. **mémoire d'idempotence** — un rejeu renvoie la même réservation sans écrire ;
   * 3. **verrou de chambre** — sérialise les créations concurrentes, chevauchantes ou non ;
   * 4. **pré-contrôle** capacité/disponibilité/devise/total — refuse **avant toute écriture** ;
   * 5. **intention de création** enregistrée, puis **écriture PMS** (`maxRetries: 0`) ;
   * 6. **promotion** de l'intention en hold + idempotence, en un seul pas ;
   * 7. **post-contrôle de total** — divergence ⇒ compensation (annulation) + 409 `price-changed`.
   *
   * ⚠️ **Frontière de compensation** : passé l'étape 5, la réservation **peut exister** côté PMS et
   * immobiliser une vraie chambre — y compris quand l'appel s'est soldé par un timeout ou une
   * coupure, cas où le BFF n'apprendra jamais son identifiant. C'est pourquoi l'intention est
   * écrite **avant** l'appel : quoi qu'il arrive ensuite, il reste une trace que le balayeur sait
   * réconcilier (`checkout-hold.sweeper.ts`). Sans elle, une `Pending` orpheline gèlerait une
   * chambre indéfiniment et le rejeu en créerait une seconde.
   */
  async createReservation(
    session: RequestSession,
    dto: CreateReservationRequestDto,
  ): Promise<BookingReservationDto> {
    this.assertStayWithinBounds(dto.checkInDate, dto.checkOutDate);

    const stay: StayFingerprint = {
      userId: session.user.userId,
      roomId: dto.roomId,
      checkInDate: dto.checkInDate,
      checkOutDate: dto.checkOutDate,
      guests: dto.guests,
    };

    const replayed = await this.replayExisting(session, dto, stay);
    if (replayed) {
      return replayed;
    }

    const token = await this.acquireStayLockOrWait(stay);
    try {
      // Relecture sous verrou : une requête concurrente du MÊME compte a pu aboutir pendant
      // notre attente. Sans cette seconde lecture, un double clic créerait deux `Pending`.
      const concurrent = await this.replayExisting(session, dto, stay);
      if (concurrent) {
        return concurrent;
      }
      return await this.createUnderLock(session, dto, stay);
    } finally {
      await this.holds.releaseStayLock(stay, token);
    }
  }

  /**
   * Relit une réservation du tunnel (story 2.4, AC-9) — reprise sans perte après rafraîchissement
   * ou retour arrière. Le PMS vérifie lui-même la propriété (403 si la réservation est celle d'un
   * autre compte) : le BFF ne relaie jamais son texte.
   */
  async getReservation(
    session: RequestSession,
    reservationId: string,
  ): Promise<BookingReservationDto> {
    const reservation = await this.fetchReservation(session, reservationId);
    if (!reservation) {
      throw toBookingException('room-not-found');
    }
    const currency = await this.hotelCurrency(this.hotelIdOf(reservation));
    return this.toReservationDto(reservation, currency, {
      ...(await this.reservationContextOf(reservationId)),
      created: false,
    });
  }

  // --- Interne : création ------------------------------------------------------------------

  /**
   * Renvoie la réservation mémorisée pour ce séjour si elle est **encore exploitable**.
   *
   * Une réservation mémorisée mais devenue `Cancelled` (balayeur, annulation manuelle) ou
   * introuvable ne doit **jamais** être resservie : on purge la mémoire et on laisse le tunnel
   * en créer une neuve. Sans cette garde, le voyageur serait renvoyé payer une réservation morte.
   *
   * Le rejeu subit **le même post-contrôle de montant** qu'une création (revue 2.4) : il
   * court-circuitait `expectedTotal`/`expectedCurrency`, si bien qu'un écran resté ouvert sur un
   * ancien prix repartait payer un montant différent de celui affiché — exactement ce que AC-2
   * interdit sur le chemin nominal.
   */
  private async replayExisting(
    session: RequestSession,
    dto: CreateReservationRequestDto,
    stay: StayFingerprint,
  ): Promise<BookingReservationDto | null> {
    const known = await this.holds.readIdempotent(stay);
    if (!known) {
      return null;
    }
    if (!isPmsGuid(known)) {
      // Mémoire corrompue : l'interpoler dans `/roomreservations/{id}` changerait l'endpoint
      // atteint. On purge (en compare-and-delete) et on repart sur une création propre.
      this.logger.error(
        `Mémoire d'idempotence inexploitable pour la chambre ${stay.roomId} — purgée.`,
      );
      await this.holds.clearIdempotent(stay, known);
      return null;
    }

    const reservation = await this.fetchReservation(session, known);
    if (!reservation || statusNameOf(reservation.status) !== 'Pending') {
      await this.holds.clearIdempotent(stay, known);
      return null;
    }

    const currency = await this.hotelCurrency(this.hotelIdOf(reservation));
    const replayed = this.toReservationDto(reservation, currency, {
      // Le contexte vient du **hold**, pas du corps rejoué : la langue qui compte est celle qui a
      // accompagné la création, pas celle que l'écran affiche peut-être depuis un autre onglet.
      ...(await this.reservationContextOf(known)),
      created: false,
    });
    this.assertReplayMatchesAnnounced(dto, replayed);
    return replayed;
  }

  /**
   * Acquiert le verrou de chambre, en scrutant brièvement s'il est détenu.
   *
   * Le perdant qui n'obtient rien reçoit un **503**, pas un 409 : la chambre n'est pas
   * indisponible, c'est notre sérialisation qui n'a pas abouti à temps. Lui annoncer
   * « plus disponible » l'enverrait chercher une alternative qui n'a pas lieu d'être.
   */
  private async acquireStayLockOrWait(stay: StayFingerprint): Promise<string> {
    const deadline = Date.now() + this.options.lockWaitTimeoutMs;
    let token = await this.holds.acquireStayLock(stay);
    while (token === null && Date.now() < deadline) {
      await delay(this.options.lockPollIntervalMs);
      token = await this.holds.acquireStayLock(stay);
    }
    if (token === null) {
      throw new ServiceUnavailableException(
        'Réservation momentanément indisponible. Réessayez dans un instant.',
      );
    }
    return token;
  }

  private async createUnderLock(
    session: RequestSession,
    dto: CreateReservationRequestDto,
    stay: StayFingerprint,
  ): Promise<BookingReservationDto> {
    // La fiche chambre d'abord : elle lit déjà `/Hotels/{id}` et `catalog` y mémorise la devise.
    // L'appel suivant est donc servi par le cache dans le cas nominal — et il n'y en a aucun si la
    // chambre est introuvable.
    const room = await this.fetchRoomForPrecheck(dto);
    // Source **unique** de devise pour toute la réservation : création, rejeu et relecture.
    const currency = await this.hotelCurrency(dto.hotelId);
    this.assertBookable(dto, room, currency);

    // Intention enregistrée AVANT l'appel : à partir d'ici, même une réponse perdue laisse une
    // trace que le balayeur saura réconcilier (correctif D1).
    const intentId = randomUUID();
    await this.holds.registerIntent({
      intentId,
      sid: session.sid,
      userId: session.user.userId,
      hotelId: dto.hotelId,
      roomId: dto.roomId,
      stay,
    });

    let created: PmsReservation | undefined;
    try {
      const res = await this.sessions.withCustomerAuth(session.sid, (token) =>
        this.pms.post<PmsReservation>(
          PMS_RESERVATION_ENDPOINTS.create(dto.hotelId),
          buildPmsCreateBody(dto),
          {
            ...this.pmsContext(),
            bearerToken: token,
            // Écriture NON idempotente côté PMS : rejouer un appel dont la réponse s'est perdue
            // créerait une SECONDE `Pending` et gèlerait une seconde chambre. Un 503 rejouable
            // par le voyageur (sous verrou et sous idempotence) vaut mieux que ce doublon.
            maxRetries: 0,
          },
        ),
      );
      created = res.data;
    } catch (err) {
      const reason = classifyReservationFailure(err);
      if (reason === null) {
        // Échec **non classé** — timeout, coupure réseau, 5xx, circuit ouvert. La requête a pu
        // atteindre le PMS et y insérer la ligne : on **laisse l'intention en place** pour que le
        // balayeur aille vérifier et annuler s'il y a lieu. La retirer ici rendrait une éventuelle
        // `Pending` définitivement invisible — une vraie chambre gelée pour toujours.
        throw err; // panne → 503 par le filtre global (jamais « chambre indisponible »)
      }
      // Refus métier explicite (4xx classé) : le PMS a rejeté la demande **avant** d'écrire. Il
      // n'y a rien à réconcilier, et garder l'intention ferait chercher au balayeur une
      // réservation qui n'existe pas.
      await this.holds.dropIntent(intentId);
      throw toBookingException(reason);
    }

    if (!created || !isPmsGuid(created.id)) {
      // Contrat rompu : 2xx sans identifiant exploitable. Ne pas fabriquer d'identifiant — mais
      // ne pas retirer l'intention non plus : le PMS a répondu 2xx, la ligne existe probablement.
      this.logger.error(
        `Création acceptée par le PMS sans identifiant exploitable (hôtel ${dto.hotelId}, ` +
          `chambre ${dto.roomId}) — intention ${intentId} laissée au balayeur.`,
      );
      throw new ServiceUnavailableException(BROKEN_CONTRACT_MESSAGE);
    }

    const reservationId = created.id;
    const expiresAt = Date.now() + this.options.holdTtlSeconds * 1000;

    // Promotion atomique : le hold est installé et l'intention retirée en un seul pas. Une panne
    // ici laisse l'intention — donc le filet — intacte.
    await this.holds.promoteIntent(intentId, {
      reservationId,
      sid: session.sid,
      userId: session.user.userId,
      hotelId: dto.hotelId,
      roomId: dto.roomId,
      expiresAt,
      stay,
    });
    await this.holds.writeIdempotent(stay, reservationId);
    // Écrite **hors** du hold, sous sa propre clé et son propre TTL : le choix suit la Réservation,
    // pas la tenue de chambre. La story 3.2 doit pouvoir le lire à la confirmation, longtemps après
    // que le hold a été libéré (revue 2ᵉ passe, F7).
    await this.holds.writeCommunicationLocale(
      reservationId,
      dto.communicationLocale ?? null,
    );

    const dtoOut = this.toReservationDto(created, currency, {
      holdExpiresAt: new Date(expiresAt).toISOString(),
      created: true,
      communicationLocale: dto.communicationLocale ?? null,
    });

    await this.assertAnnouncedTotal(session, dto, stay, dtoOut);
    return dtoOut;
  }

  /**
   * Pré-contrôle **sans écriture** : capacité, disponibilité, exploitabilité des dates, devise
   * **et total annoncé**.
   *
   * Il ne remplace pas la vérité de la création — il évite une écriture vouée à l'échec et, surtout,
   * **qualifie le motif** : le PMS valide la disponibilité *avant* la capacité, si bien qu'une
   * chambre trop petite ET prise ressort en « indisponible ». Or le dépassement de capacité est une
   * cause déterministe que le voyageur peut corriger — elle prime sur l'avis générique
   * d'indisponibilité (règle tranchée en revue 2.2).
   *
   * Le **total** y est confronté à `expectedTotal` (revue 2.4) : le montant était déjà calculé ici
   * pour le contrôle de devise, mais n'était comparé qu'*après* la création — un écran périmé
   * provoquait donc une création **puis** une annulation, deux écritures réelles dans la base
   * partagée avec le back-office, pour un refus connaissable avant la première.
   */
  private async fetchRoomForPrecheck(
    dto: CreateReservationRequestDto,
  ): Promise<RoomDetailDto> {
    try {
      return await this.catalog.getRoomDetail(dto.hotelId, dto.roomId, {
        checkInDate: dto.checkInDate,
        checkOutDate: dto.checkOutDate,
        guests: dto.guests,
      });
    } catch (err) {
      if (err instanceof PmsRequestError) {
        if (err.status === 404) {
          throw toBookingException('room-not-found');
        }
        // Tout autre 4xx sur une lecture publique est une anomalie d'intégration, pas un refus
        // que le voyageur peut corriger — et son texte ne doit pas atteindre le navigateur.
        this.logger.error(
          `Pré-contrôle refusé par le PMS (statut ${err.status}) pour la chambre ${dto.roomId} ` +
            `de l'hôtel ${dto.hotelId}.`,
        );
        throw new ServiceUnavailableException(BROKEN_CONTRACT_MESSAGE);
      }
      throw err; // PmsUnavailableError → 503 par le filtre global
    }
  }

  /** Gardes **pures** du pré-contrôle : aucune I/O, donc aucune écriture possible entre-temps. */
  private assertBookable(
    dto: CreateReservationRequestDto,
    room: RoomDetailDto,
    currency: string,
  ): void {
    if (room.capacity !== null && dto.guests > room.capacity) {
      throw toBookingException('over-capacity');
    }
    // Une disponibilité **indéterminée** (cross-check PMS en panne) ne bloque jamais : c'est la
    // création qui tranchera. La présenter comme « indisponible » serait un faux négatif.
    if (!room.available && !room.availabilityDegraded) {
      throw toBookingException('room-unavailable');
    }
    if (room.nights === null || room.nights <= 0) {
      throw toBookingException('invalid-dates');
    }

    if (room.currency !== currency) {
      // Les deux caches de `catalog` (fiche chambre / devise d'hôtel) se contredisent : le tarif
      // est libellé dans une monnaie, la réservation le sera dans l'autre. Aucun montant ne peut
      // être annoncé honnêtement — on refuse **sans** en proposer un (AR-12).
      this.logger.error(
        `Devises incohérentes pour la chambre ${dto.roomId} (hôtel ${dto.hotelId}) : ` +
          `fiche chambre ${room.currency}, hôtel ${currency}.`,
      );
      throw toBookingException('price-changed');
    }
    if (currency !== dto.expectedCurrency) {
      // L'écran affichait une autre monnaie que celle qui sera débitée : refuser avant d'écrire.
      throw toBookingException('price-changed', {
        total: room.pricePerNight * room.nights,
        currency,
      });
    }

    const announced = room.pricePerNight * room.nights;
    if (announced <= 0) {
      // Un total nul ou négatif n'est pas un tarif : le laisser passer produirait une réservation
      // à prix zéro que le parcours de re-confirmation accepterait ensuite en 201.
      this.logger.error(
        `Total non vendable pour la chambre ${dto.roomId} (hôtel ${dto.hotelId}) : ` +
          `${room.pricePerNight} × ${room.nights} ${currency}.`,
      );
      throw new ServiceUnavailableException(BROKEN_CONTRACT_MESSAGE);
    }
    if (announced !== dto.expectedTotal) {
      throw toBookingException('price-changed', {
        total: announced,
        currency,
      });
    }
  }

  /**
   * Post-contrôle **bloquant** du total (AC-2) — le seul montant qui engage est celui que le PMS
   * a persisté.
   *
   * Le BFF arrondit le tarif *puis* multiplie par les nuits ; le PMS multiplie en `decimal` *puis*
   * persiste. Tant que le tarif tient dans l'exposant de la devise les deux coïncident ; au-delà
   * ils divergent de quelques unités mineures — et le voyageur paierait un montant différent de
   * celui annoncé (UX-DR-9.2). En cas d'écart, la réservation est **annulée** et l'écran doit
   * faire re-confirmer le nouveau total.
   */
  private async assertAnnouncedTotal(
    session: RequestSession,
    dto: CreateReservationRequestDto,
    stay: StayFingerprint,
    reservation: BookingReservationDto,
  ): Promise<void> {
    if (reservation.total <= 0) {
      // Le PMS a persisté un montant nul ou négatif. Le rendre au front le ferait re-confirmer
      // « au nouveau prix » — et accepter une réservation gratuite en 201.
      this.logger.error(
        `Réservation ${reservation.reservationId} persistée avec un total non vendable ` +
          `(${reservation.total} ${reservation.currency}) — annulation compensatoire.`,
      );
      await this.compensate(session, stay, reservation);
      throw new ServiceUnavailableException(BROKEN_CONTRACT_MESSAGE);
    }

    if (reservation.total === dto.expectedTotal) {
      return;
    }

    this.logger.warn(
      `Total divergent pour la réservation ${reservation.reservationId} : annoncé ${dto.expectedTotal}, ` +
        `PMS ${reservation.total} ${reservation.currency} — annulation compensatoire.`,
    );

    await this.compensate(session, stay, reservation);

    throw toBookingException('price-changed', {
      total: reservation.total,
      currency: reservation.currency,
    });
  }

  /**
   * Refuse un **rejeu** dont le montant mémorisé ne correspond plus à ce que l'écran annonce.
   *
   * Aucune compensation ici : la réservation est parfaitement légitime, c'est l'attente du client
   * qui est périmée. L'annuler punirait un voyageur dont l'onglet est simplement resté ouvert.
   */
  private assertReplayMatchesAnnounced(
    dto: CreateReservationRequestDto,
    replayed: BookingReservationDto,
  ): void {
    if (
      replayed.currency === dto.expectedCurrency &&
      replayed.total === dto.expectedTotal
    ) {
      return;
    }
    this.logger.warn(
      `Rejeu divergent pour la réservation ${replayed.reservationId} : annoncé ` +
        `${dto.expectedTotal} ${dto.expectedCurrency}, mémorisé ${replayed.total} ` +
        `${replayed.currency} — re-confirmation requise.`,
    );
    throw toBookingException('price-changed', {
      total: replayed.total,
      currency: replayed.currency,
    });
  }

  /**
   * Compensation d'une réservation qui vient d'être créée mais ne peut pas être servie.
   *
   * L'annulation est best-effort : si elle échoue, le hold reste (le balayeur reprendra la main)
   * mais la mémoire d'idempotence part — un rejeu ne doit pas resservir une réservation condamnée.
   */
  private async compensate(
    session: RequestSession,
    stay: StayFingerprint,
    reservation: BookingReservationDto,
  ): Promise<void> {
    const cancelled = await this.cancelQuietly(
      session,
      reservation.reservationId,
    );
    if (cancelled) {
      await this.holds.release(reservation.reservationId);
    } else {
      await this.holds.clearIdempotent(stay, reservation.reservationId);
    }
  }

  /** Annulation compensatoire — best-effort ; `false` si elle n'a pas abouti. */
  private async cancelQuietly(
    session: RequestSession,
    reservationId: string,
  ): Promise<boolean> {
    try {
      await this.sessions.withCustomerAuth(session.sid, (token) =>
        this.pms.post(
          PMS_RESERVATION_ENDPOINTS.cancel(reservationId),
          undefined,
          {
            ...this.pmsContext(),
            bearerToken: token,
          },
        ),
      );
      return true;
    } catch (err) {
      this.logger.error(
        `Annulation compensatoire impossible pour la réservation ${reservationId} : ` +
          `${err instanceof Error ? err.message : 'erreur inconnue'}. Le balayeur reprendra la main.`,
      );
      return false;
    }
  }

  // --- Interne : lecture -------------------------------------------------------------------

  /** `GET /roomreservations/{id}` ; `null` si le PMS la refuse (introuvable ou d'un autre compte). */
  private async fetchReservation(
    session: RequestSession,
    reservationId: string,
  ): Promise<PmsReservation | null> {
    try {
      const res = await this.sessions.withCustomerAuth(session.sid, (token) =>
        this.pms.get<PmsReservation>(
          PMS_RESERVATION_ENDPOINTS.byId(reservationId),
          { ...this.pmsContext(), bearerToken: token },
        ),
      );
      return res.data ?? null;
    } catch (err) {
      if (
        err instanceof PmsRequestError &&
        (err.status === 404 || err.status === 403)
      ) {
        // Introuvable ou appartenant à un autre compte : indiscernables à dessein côté navigateur
        // (ne pas offrir d'oracle d'existence de réservation).
        return null;
      }
      throw err; // 401 géré par withCustomerAuth ; panne → 503
    }
  }

  /**
   * Devise de l'hôtel — **source unique** du module, et frontière d'erreur.
   *
   * `CatalogService.getHotelCurrency` lève une `PmsRequestError` que le filtre global relaierait
   * telle quelle, `message` **et** `errors` compris : le corps d'erreur du PMS atteindrait le
   * navigateur sur une simple relecture de réservation. Tout 4xx est donc converti ici en message
   * BFF ; seul le 404 garde un sens métier (hôtel introuvable).
   */
  private async hotelCurrency(hotelId: string): Promise<string> {
    try {
      return await this.catalog.getHotelCurrency(hotelId);
    } catch (err) {
      if (err instanceof PmsRequestError) {
        if (err.status === 404) {
          throw toBookingException('room-not-found');
        }
        this.logger.error(
          `Devise de l'hôtel ${hotelId} refusée par le PMS (statut ${err.status}).`,
        );
        throw new ServiceUnavailableException(BROKEN_CONTRACT_MESSAGE);
      }
      throw err; // PmsUnavailableError → 503 par le filtre global
    }
  }

  /**
   * Identifiant d'hôtel **exploitable** d'une réservation relue.
   *
   * `reservation.hotelId ?? ''` ciblait l'endpoint **liste** `/Hotels/` quand le champ manquait :
   * le BFF interrogeait alors tout le catalogue pour en déduire une devise, et servait ce que ce
   * corps contenait. Un identifiant absent est une rupture de contrat, pas une valeur par défaut.
   */
  private hotelIdOf(reservation: PmsReservation): string {
    const hotelId = reservation.hotelId;
    if (!isPmsGuid(hotelId)) {
      this.logger.error(
        `Réservation ${reservation.id ?? 'inconnue'} sans hôtel exploitable : ` +
          "impossible d'en résoudre la devise.",
      );
      throw new ServiceUnavailableException(BROKEN_CONTRACT_MESSAGE);
    }
    return hotelId;
  }

  /**
   * Contexte de tunnel d'une réservation : échéance du hold **et** langue de communication.
   *
   * ⚠️ Deux durées de vie **différentes**, et c'est délibéré (revue 2ᵉ passe, F7) :
   * - l'**échéance** vit sur l'enregistrement de hold, supprimé dès que le balayeur libère la
   *   chambre. `null` dès qu'elle est atteinte : un hold échu ne tient plus rien.
   * - la **langue** vit sous sa propre clé, avec un TTL aligné sur l'expiration des `Pending`
   *   (48 h). Elle décrit un choix du voyageur, pas une promesse de disponibilité : la lier au
   *   hold la faisait disparaître de l'écran quand la chambre était libérée — alors que l'écran
   *   affirme « enregistré avec votre réservation ».
   *
   * Les deux lectures partent **en parallèle** : elles sont indépendantes.
   */
  private async reservationContextOf(reservationId: string): Promise<{
    holdExpiresAt: string | null;
    communicationLocale: CommunicationLocale | null;
  }> {
    const [record, communicationLocale] = await Promise.all([
      this.holds.read(reservationId),
      this.holds.readCommunicationLocale(reservationId),
    ]);
    return {
      holdExpiresAt:
        record && record.expiresAt > Date.now()
          ? new Date(record.expiresAt).toISOString()
          : null,
      communicationLocale,
    };
  }

  private toReservationDto(
    reservation: PmsReservation,
    currency: string,
    extras: {
      holdExpiresAt: string | null;
      created: boolean;
      communicationLocale: CommunicationLocale | null;
    },
  ): BookingReservationDto {
    // ⚠️ `?? 0` fabriquait un montant : une réservation sans `totalPrice` ressortait à `total: 0`,
    // que le parcours de re-confirmation faisait ensuite accepter en 201 — une réservation
    // gratuite dans une base partagée avec le back-office. L'absence de total est une rupture de
    // contrat, traitée comme telle (même discipline que le 2xx sans identifiant).
    const totalPrice = reservation.totalPrice;
    if (typeof totalPrice !== 'number' || !Number.isFinite(totalPrice)) {
      this.logger.error(
        `Réservation ${reservation.id ?? 'inconnue'} servie par le PMS sans total exploitable.`,
      );
      throw new ServiceUnavailableException(BROKEN_CONTRACT_MESSAGE);
    }

    return {
      reservationId: reservation.id ?? '',
      reservationCode: reservation.reservationCode ?? '',
      status: statusNameOf(reservation.status),

      hotelId: reservation.hotelId ?? '',
      hotelName: reservation.hotelName ?? null,
      roomId: reservation.roomId ?? '',
      roomNumber: reservation.roomNumber ?? null,
      roomCategory: reservation.roomCategory ?? null,

      // Le PMS renvoie des datetimes ; le tunnel raisonne en date-only (URL, devis, affichage).
      checkInDate: dateOnly(reservation.checkInDate),
      checkOutDate: dateOnly(reservation.checkOutDate),
      nights: reservation.numberOfNights ?? 0,
      guests: reservation.numberOfGuests ?? 0,

      currency,
      // La devise ne vient PAS du DTO du PMS (il n'en porte aucune) : elle est résolue depuis
      // l'Hôtel, et son exposant commande la conversion (MGA ×1, EUR ×100, KWD ×1000).
      pricePerNight: toMinorUnits(reservation.pricePerNight ?? 0, currency),
      total: toMinorUnits(totalPrice, currency),

      holdExpiresAt: extras.holdExpiresAt,

      // Relu du PMS, **jamais** l'écho du corps envoyé : sur un rejeu, la réservation porte le
      // texte de la première soumission, et c'est celui-là qui est réellement attaché (AC-6).
      // `?? null` et non `?? ''` : une absence est une absence.
      specialRequests: reservation.specialRequests ?? null,
      communicationLocale: extras.communicationLocale,
      // ⚠️ D10 — bascule vers `'applied'` **uniquement** le jour où le PMS porte la langue de la
      // réservation ET s'en sert pour l'email/le PDF. Aujourd'hui `EmailOutboxProcessor` la résout
      // depuis `HotelCommunicationSettings.DefaultLanguage` : annoncer `applied` serait un mensonge.
      communicationLocaleState: 'hotel_default_fallback',

      created: extras.created,
    };
  }

  // --- Interne : garde-fous partagés -------------------------------------------------------

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

  private pmsContext(): PmsRequestContext | undefined {
    const correlationId = this.correlation.getCorrelationId();
    return correlationId ? { correlationId } : undefined;
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

/**
 * Corps de création envoyé au PMS — **SEUL point de bascule** de la dépendance D10 (story 2.5).
 *
 * ## Ce qui part aujourd'hui
 *
 * `roomId`, dates ancrées UTC, nombre de voyageurs, moyen de paiement, et `specialRequests`
 * **uniquement si elles existent** : la clé est omise plutôt qu'envoyée à `null`, pour que
 * `RoomReservation.SpecialRequests` reste réellement nulle côté PMS.
 *
 * ## Ce qui ne part pas — et pourquoi
 *
 * ⚠️ **D10 — `communicationLocale` n'est PAS transmise.** Le PMS ne porte aucun champ de langue sur
 * la réservation (`RoomReservation` n'en a pas, `CreateRoomReservationDto` non plus), et son moteur
 * d'emails résout la langue depuis `HotelCommunicationSettings.DefaultLanguage`
 * (`EmailOutboxProcessor.cs:229`). L'envoyer quand même serait pire qu'inutile : le champ serait
 * ignoré en silence et donnerait l'illusion d'une fonctionnalité livrée.
 *
 * Le jour où D10 arrive, la langue s'ajoute **ICI et nulle part ailleurs** — plus
 * `communicationLocaleState: 'applied'` dans `toReservationDto`, et le texte de repli côté front.
 * En attendant, le choix vit sur l'enregistrement de hold (`CheckoutHoldRecord.communicationLocale`).
 */
function buildPmsCreateBody(
  dto: CreateReservationRequestDto,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    roomId: dto.roomId,
    // Dates ancrées UTC : une date-only arriverait en `Kind=Unspecified` et Npgsql rejetterait
    // l'écriture sur une colonne `timestamptz` (500). Piège déjà rencontré.
    checkInDate: toPmsUtcDateTime(dto.checkInDate),
    checkOutDate: toPmsUtcDateTime(dto.checkOutDate),
    numberOfGuests: dto.guests,
    // Une réservation en ligne payée par carte : l'enregistrer en « espèces » (défaut du DTO PMS)
    // fausserait le back-office Manager, qui partage cette base.
    paymentMethod: PAYMENT_METHOD_STRIPE,
  };

  // Normalisées et bornées par le DTO d'entrée : ce qui arrive ici est déjà transmissible tel quel.
  if (
    typeof dto.specialRequests === 'string' &&
    dto.specialRequests.length > 0
  ) {
    body.specialRequests = dto.specialRequests;
  }

  return body;
}

/** Ancre une date-only `AAAA-MM-JJ` en datetime UTC pour la liaison `DateTime` du PMS. */
function toPmsUtcDateTime(dateOnly: string): string {
  return `${dateOnly}T00:00:00Z`;
}

/** Extrait la date-only d'un datetime PMS ; chaîne vide si le champ manque. */
function dateOnly(value: string | null | undefined): string {
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

/**
 * Nom de statut PMS. Un code inconnu devient `Unknown` — **jamais** `Pending` par défaut :
 * traiter un statut non reconnu comme « en attente » autoriserait le balayeur à annuler une
 * réservation dont il ignore l'état (FR-14).
 */
function statusNameOf(status: number | undefined): ReservationStatusName {
  return status !== undefined ? (STATUS_NAMES[status] ?? 'Unknown') : 'Unknown';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
