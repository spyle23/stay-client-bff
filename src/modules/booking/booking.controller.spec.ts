import { HttpStatus } from '@nestjs/common';
// Les jetons de métadonnées ne sont pas réexportés par l'index du paquet (v6) : import direct du
// sous-chemin, comme `ThrottlerStorageRecord` dans `redis-throttler.storage.ts`.
import {
  THROTTLER_BLOCK_DURATION,
  THROTTLER_LIMIT,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import type { Response } from 'express';
import type { RequestSession } from '../../common/decorators/current-session.decorator';
import {
  reservationIdentityLimit,
  resolveThrottlerOptions,
  THROTTLER_NAMES,
} from '../../common/throttler/throttler.constants';
import type { BookingService } from './booking.service';
import { BookingController } from './booking.controller';
import type { BookingQuoteDto } from './dto/booking-quote.dto';
import type { BookingQuoteQueryDto } from './dto/booking-quote.query.dto';
import type { CreateReservationRequestDto } from './dto/create-reservation.request.dto';
import type { BookingReservationDto } from './dto/reservation.dto';

const query: BookingQuoteQueryDto = {
  hotelId: '11111111-1111-1111-1111-111111111111',
  roomId: '22222222-2222-2222-2222-222222222222',
  checkInDate: '2099-07-05',
  checkOutDate: '2099-07-07',
  guests: 2,
};

const quote = { total: 16800, currency: 'EUR' } as BookingQuoteDto;

describe('BookingController', () => {
  it('réexpose le devis dans l’enveloppe ApiResponse<T> (contrat identique au PMS)', async () => {
    const getQuote = jest.fn().mockResolvedValue(quote);
    const controller = new BookingController({
      getQuote,
    } as unknown as BookingService);

    const response = await controller.getQuote(query);

    expect(getQuote).toHaveBeenCalledWith(query);
    expect(response).toEqual({ success: true, data: quote });
  });
});

const SESSION: RequestSession = {
  sid: 'sid-1',
  user: {
    userId: '55555555-5555-5555-5555-555555555555',
    email: 'lea@example.com',
    firstName: null,
    lastName: null,
  },
};

const createBody: CreateReservationRequestDto = {
  hotelId: query.hotelId,
  roomId: query.roomId,
  checkInDate: query.checkInDate,
  checkOutDate: query.checkOutDate,
  guests: 2,
  expectedTotal: 16_800,
  expectedCurrency: 'EUR',
};

function fakeResponse() {
  const headers = new Map<string, string>();
  return {
    status: jest.fn(),
    setHeader: jest.fn((name: string, value: string) =>
      headers.set(name, value),
    ),
    headers,
  };
}

function reservation(
  overrides: Partial<BookingReservationDto> = {},
): BookingReservationDto {
  return {
    reservationId: '44444444-4444-4444-4444-444444444444',
    reservationCode: 'RES-20260901-A1B2C',
    status: 'Pending',
    hotelId: query.hotelId,
    hotelName: 'Hôtel Colline',
    roomId: query.roomId,
    roomNumber: '204',
    roomCategory: 'Double Confort',
    checkInDate: query.checkInDate,
    checkOutDate: query.checkOutDate,
    nights: 2,
    guests: 2,
    currency: 'EUR',
    pricePerNight: 8400,
    total: 16_800,
    roomTotal: 16_800,
    servicesTotal: 0,
    services: [],
    holdExpiresAt: '2099-07-05T10:15:00.000Z',
    specialRequests: null,
    communicationLocale: null,
    communicationLocaleState: 'hotel_default_fallback',
    created: true,
    ...overrides,
  };
}

describe('BookingController — réservations (story 2.4)', () => {
  it('répond 201 quand la réservation vient d’être créée', async () => {
    const createReservation = jest.fn().mockResolvedValue(reservation());
    const controller = new BookingController({
      createReservation,
    } as unknown as BookingService);
    const res = fakeResponse();

    const response = await controller.createReservation(
      SESSION,
      createBody,
      res as unknown as Response,
    );

    expect(createReservation).toHaveBeenCalledWith(SESSION, createBody);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.CREATED);
    expect(response).toEqual({ success: true, data: reservation() });
  });

  it('répond 200 sur rejeu idempotent (la distinction reste observable)', async () => {
    const controller = new BookingController({
      createReservation: jest
        .fn()
        .mockResolvedValue(reservation({ created: false })),
    } as unknown as BookingService);
    const res = fakeResponse();

    await controller.createReservation(
      SESSION,
      createBody,
      res as unknown as Response,
    );

    expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
  });

  it('interdit la mise en cache des réponses liées à une session', async () => {
    const controller = new BookingController({
      createReservation: jest.fn().mockResolvedValue(reservation()),
    } as unknown as BookingService);
    const res = fakeResponse();

    await controller.createReservation(
      SESSION,
      createBody,
      res as unknown as Response,
    );

    // Sans ces directives, un cache partagé pourrait resservir la réservation d'un voyageur
    // à un autre visiteur.
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(res.headers.get('Vary')).toBe('Cookie');
  });

  it('relit une réservation dans l’enveloppe ApiResponse<T>', async () => {
    const getReservation = jest
      .fn()
      .mockResolvedValue(reservation({ created: false }));
    const controller = new BookingController({
      getReservation,
    } as unknown as BookingService);
    const res = fakeResponse();

    const response = await controller.getReservation(
      SESSION,
      '44444444-4444-4444-4444-444444444444',
      res as unknown as Response,
    );

    expect(getReservation).toHaveBeenCalledWith(
      SESSION,
      '44444444-4444-4444-4444-444444444444',
    );
    expect(response.success).toBe(true);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });
});

/**
 * Politique de débit **posée sur la route** (story 2.4 — T6), et non héritée en silence des
 * limiteurs globaux : le seuil qui s'applique réellement à la création doit être lisible ici.
 */
describe('BookingController — politique de débit de la création', () => {
  // `@Throttle` pose ses métadonnées sur la **valeur du descripteur** de la méthode : on la lit
  // telle quelle, sans détacher la méthode de son objet (règle `unbound-method`).
  const handler = Object.getOwnPropertyDescriptor(
    BookingController.prototype,
    'createReservation',
  )?.value as object;

  const resolvable = (token: string, name: string) =>
    Reflect.getMetadata(`${token}${name}`, handler) as
      (() => number) | undefined;

  it('déclare explicitement les DEUX compteurs nommés (ip + identity)', () => {
    for (const name of [THROTTLER_NAMES.ip, THROTTLER_NAMES.identity]) {
      for (const token of [
        THROTTLER_LIMIT,
        THROTTLER_TTL,
        THROTTLER_BLOCK_DURATION,
      ]) {
        expect(typeof resolvable(token, name)).toBe('function');
      }
    }
  });

  it('relève le seuil d’identité pour absorber les rejeux idempotents (AC-5)', () => {
    const options = resolveThrottlerOptions();
    const identity = resolvable(THROTTLER_LIMIT, THROTTLER_NAMES.identity);

    expect(identity?.()).toBe(reservationIdentityLimit(options));
    // Le guard compte AVANT que le service ne reconnaisse un rejeu : au seuil nu, un double-clic
    // suivi d'un F5 consommait le quota du voyageur sans qu'aucune requête n'ait rien créé.
    expect(identity?.()).toBeGreaterThan(options.identityLimit);
  });

  it('laisse le seuil par IP inchangé (c’est lui qui protège l’écriture)', () => {
    const ip = resolvable(THROTTLER_LIMIT, THROTTLER_NAMES.ip);
    expect(ip?.()).toBe(resolveThrottlerOptions().ipLimit);
  });
});
