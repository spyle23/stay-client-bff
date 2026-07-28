import { BadRequestException, Logger } from '@nestjs/common';
import type { CatalogService } from '../catalog/catalog.service';
import type { RoomDetailDto } from '../catalog/dto/room-detail.dto';
import {
  PmsRequestError,
  PmsUnavailableError,
} from '../../integration/pms/pms-errors';
import type { BookingOptions } from './booking.constants';
import { BookingService } from './booking.service';
import type { BookingQuoteQueryDto } from './dto/booking-quote.query.dto';

const HOTEL_ID = '11111111-1111-1111-1111-111111111111';
const ROOM_ID = '22222222-2222-2222-2222-222222222222';

/** Date-only UTC décalée de `days` jours. */
function isoDatePlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const query: BookingQuoteQueryDto = {
  hotelId: HOTEL_ID,
  roomId: ROOM_ID,
  checkInDate: isoDatePlus(30),
  checkOutDate: isoDatePlus(32), // 2 nuits
  guests: 2,
};

function roomDetail(overrides: Partial<RoomDetailDto> = {}): RoomDetailDto {
  return {
    id: ROOM_ID,
    hotelId: HOTEL_ID,
    hotelName: 'Hôtel Colline',
    hotelCity: 'Antananarivo',
    hotelLogoUrl: 'https://pms/img/logo.png',
    number: '204',
    category: 'Double Confort',
    capacity: 2,
    amenities: 'wifi,clim',
    floor: 2,
    description: 'Chambre lumineuse',
    includedServices: [],
    images: [
      { url: 'https://pms/img/a.jpg' },
      { url: 'https://pms/img/b.jpg' },
    ],
    pricePerNight: 8400,
    totalPrice: 16800,
    currency: 'EUR',
    nights: 2,
    available: true,
    availabilityDegraded: false,
    ...overrides,
  };
}

describe('BookingService', () => {
  let getRoomDetail: jest.Mock;
  let service: BookingService;
  const options: BookingOptions = { maxStayNights: 90 };

  beforeEach(() => {
    getRoomDetail = jest.fn().mockResolvedValue(roomDetail());
    service = new BookingService(
      { getRoomDetail } as unknown as CatalogService,
      options,
    );
  });

  it('délègue à CatalogService avec le contexte de séjour (aucune composition PMS parallèle)', async () => {
    await service.getQuote(query);
    expect(getRoomDetail).toHaveBeenCalledTimes(1);
    expect(getRoomDetail).toHaveBeenCalledWith(HOTEL_ID, ROOM_ID, {
      checkInDate: query.checkInDate,
      checkOutDate: query.checkOutDate,
      guests: 2,
    });
  });

  it('compose un devis complet : hôtel, chambre, séjour, ventilation et total', async () => {
    const quote = await service.getQuote(query);

    expect(quote.hotelId).toBe(HOTEL_ID);
    expect(quote.hotelName).toBe('Hôtel Colline');
    // AC-1 : le logo de l'Hôtel est transporté, plus figé à `null` (revue 2.2).
    expect(quote.hotelLogoUrl).toBe('https://pms/img/logo.png');
    expect(quote.hotelCity).toBe('Antananarivo');
    expect(quote.roomId).toBe(ROOM_ID);
    expect(quote.roomCategory).toBe('Double Confort');
    expect(quote.roomNumber).toBe('204');
    expect(quote.roomCapacity).toBe(2);
    // Photo principale = la première (catalog trie déjà primaire d'abord).
    expect(quote.roomImageUrl).toBe('https://pms/img/a.jpg');
    expect(quote.checkInDate).toBe(query.checkInDate);
    expect(quote.checkOutDate).toBe(query.checkOutDate);
    expect(quote.nights).toBe(2);
    expect(quote.guests).toBe(2);
    expect(quote.currency).toBe('EUR');
    expect(quote.pricePerNight).toBe(8400);
    expect(quote.roomTotal).toBe(16800);
    expect(quote.total).toBe(16800);
    expect(Number.isInteger(quote.total)).toBe(true);
    expect(quote.available).toBe(true);
    expect(quote.availabilityDegraded).toBe(false);
    expect(Date.parse(quote.quotedAt)).not.toBeNaN();
  });

  /**
   * ⚠️ Portée réelle de ce test : `CatalogService` étant mocké, `toMinorUnits`/`minorUnitExponent`
   * ne s'exécutent PAS ici — il prouve que le devis **transporte** la devise de l'Hôtel et ses
   * unités mineures sans les réinterpréter (pas de ×100 rajouté, pas de repli sur EUR), et que la
   * multiplication par les nuits reste entière quel que soit l'exposant. L'application effective
   * de l'exposant est couverte par `minor-units.spec.ts` et par l'e2e `booking-quote` en devise à
   * 0 décimale (revue 2.2).
   */
  it('transporte la devise de l’Hôtel et ses unités mineures sans les réinterpréter (MGA, 0 décimale)', async () => {
    getRoomDetail.mockResolvedValue(
      roomDetail({
        currency: 'MGA',
        pricePerNight: 250_000,
        totalPrice: 500_000,
      }),
    );
    const quote = await service.getQuote(query);
    expect(quote.currency).toBe('MGA');
    expect(quote.pricePerNight).toBe(250_000);
    expect(quote.total).toBe(500_000);
    expect(Number.isInteger(quote.total)).toBe(true);
  });

  it('recalcule le total depuis prix/nuit × nuits (formule unique, cohérence au centime)', async () => {
    getRoomDetail.mockResolvedValue(
      roomDetail({ pricePerNight: 9999, totalPrice: 19_998, nights: 2 }),
    );
    const quote = await service.getQuote(query);
    expect(quote.roomTotal).toBe(9999 * 2);
  });

  it('n’invente jamais de taxe tant que D7 n’est pas livré', async () => {
    const quote = await service.getQuote(query);
    expect(quote.taxAmount).toBeNull();
    expect(quote.taxState).toBe('included_undetailed');
    // Le total ne contient aucun poste fantôme : total = sous-total chambre.
    expect(quote.total).toBe(quote.roomTotal);
  });

  it('rend un repli de politique d’annulation sans aucune valeur fabriquée (D2 non livré)', async () => {
    const quote = await service.getQuote(query);
    expect(quote.cancellationPolicy).toEqual({
      source: 'fallback',
      refundable: null,
      freeUntil: null,
      terms: null,
    });
  });

  it('propage la disponibilité dégradée (jamais présentée comme « indisponible »)', async () => {
    getRoomDetail.mockResolvedValue(
      roomDetail({ available: true, availabilityDegraded: true }),
    );
    const quote = await service.getQuote(query);
    expect(quote.availabilityDegraded).toBe(true);
    expect(quote.available).toBe(true);
  });

  it('propage une chambre devenue indisponible pour ces dates', async () => {
    getRoomDetail.mockResolvedValue(roomDetail({ available: false }));
    const quote = await service.getQuote(query);
    expect(quote.available).toBe(false);
  });

  it('refuse un devis quand catalog a écarté le contexte de dates (400, jamais un total null)', async () => {
    getRoomDetail.mockResolvedValue(
      roomDetail({ nights: null, totalPrice: null }),
    );
    await expect(service.getQuote(query)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  /**
   * Revue 2.2 : la borne est une **règle de query**, connue avant toute I/O. La vérifier après la
   * composition ferait partir trois appels PMS — et mettre le résultat en cache — pour un contexte
   * que l'on savait refusé dès sa lecture. Le rejet doit donc précéder `getRoomDetail`.
   */
  it('refuse un séjour au-delà de la borne du module SANS appeler le PMS', async () => {
    service = new BookingService(
      { getRoomDetail } as unknown as CatalogService,
      { maxStayNights: 1 },
    );
    await expect(service.getQuote(query)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(getRoomDetail).not.toHaveBeenCalled();
  });

  it('accepte un séjour exactement sur la borne (pas d’off-by-one)', async () => {
    service = new BookingService(
      { getRoomDetail } as unknown as CatalogService,
      { maxStayNights: 2 },
    );
    getRoomDetail.mockResolvedValue(roomDetail({ nights: 2 }));
    await expect(service.getQuote(query)).resolves.toMatchObject({ nights: 2 });
    expect(getRoomDetail).toHaveBeenCalledTimes(1);
  });

  /**
   * Filet conservé : si `catalog` écartait silencieusement un contexte que la borne du module
   * accepte (règle plus stricte de son côté), le devis doit encore refuser plutôt que rendre un
   * total `null`.
   */
  it('refuse encore si catalog écarte un séjour que la borne du module acceptait', async () => {
    getRoomDetail.mockResolvedValue(
      roomDetail({ nights: null, totalPrice: null }),
    );
    await expect(service.getQuote(query)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(getRoomDetail).toHaveBeenCalledTimes(1);
  });

  it('propage un 404 PMS (chambre/hôtel introuvable)', async () => {
    getRoomDetail.mockRejectedValue(
      new PmsRequestError('Chambre introuvable.', 404),
    );
    await expect(service.getQuote(query)).rejects.toBeInstanceOf(
      PmsRequestError,
    );
  });

  it('propage une panne PMS (503 — dégradation gracieuse, jamais un devis inventé)', async () => {
    getRoomDetail.mockRejectedValue(new PmsUnavailableError('PMS injoignable'));
    await expect(service.getQuote(query)).rejects.toBeInstanceOf(
      PmsUnavailableError,
    );
  });

  /**
   * ⚠️ Filet de **non-régression de contrat**, pas scénario de production : aujourd'hui
   * `catalog.toRoomDetailDto` calcule `totalPrice` par exactement `pricePerNight × nights`, donc
   * cette branche est inatteignable tant que cette formule ne change pas. Le mock forge donc
   * délibérément un état que `catalog` ne produit pas — c'est le seul moyen de vérifier que le
   * garde-fou parlerait si la formule divergeait un jour. Le risque *réel* de divergence (total
   * BFF vs total recalculé en `decimal` par le PMS à la création) est détecté par
   * `hasSubMinorPrecision` et sera **bloquant** en story 2.4 (revue 2.2).
   */
  it('loggue un avertissement si le contrat catalog cessait de vérifier total = prix/nuit × nuits', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    getRoomDetail.mockResolvedValue(
      roomDetail({ pricePerNight: 8400, totalPrice: 16_799, nights: 2 }),
    );

    const quote = await service.getQuote(query);

    // Le devis reste cohérent avec le prix/nuit AFFICHÉ (la formule fait foi).
    expect(quote.roomTotal).toBe(16_800);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(ROOM_ID));
    warn.mockRestore();
  });
});
