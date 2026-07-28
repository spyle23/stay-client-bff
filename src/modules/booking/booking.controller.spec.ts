import type { BookingService } from './booking.service';
import { BookingController } from './booking.controller';
import type { BookingQuoteDto } from './dto/booking-quote.dto';
import type { BookingQuoteQueryDto } from './dto/booking-quote.query.dto';

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
