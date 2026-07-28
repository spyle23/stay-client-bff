import { resolveBookingOptions } from './booking.constants';

describe('resolveBookingOptions', () => {
  it('applique les défauts documentés', () => {
    const options = resolveBookingOptions({});
    expect(options.maxStayNights).toBe(90);
  });

  /**
   * Même piège que `catalog` : une option fractionnaire est acceptée par `Number()` puis rejetée
   * plus bas (Redis, arithmétique de nuits) — borner sans normaliser est une validation en
   * trompe-l'œil.
   */
  it('normalise en entier', () => {
    const options = resolveBookingOptions({ BOOKING_MAX_STAY_NIGHTS: '30.9' });
    expect(options.maxStayNights).toBe(30);
    expect(Number.isInteger(options.maxStayNights)).toBe(true);
  });

  it('borne les valeurs hors plage et ignore les valeurs non parsables', () => {
    expect(
      resolveBookingOptions({ BOOKING_MAX_STAY_NIGHTS: '0' }).maxStayNights,
    ).toBe(1);
    expect(
      resolveBookingOptions({ BOOKING_MAX_STAY_NIGHTS: '99999' }).maxStayNights,
    ).toBe(365);
    expect(
      resolveBookingOptions({ BOOKING_MAX_STAY_NIGHTS: 'abc' }).maxStayNights,
    ).toBe(90);
    expect(
      resolveBookingOptions({ BOOKING_MAX_STAY_NIGHTS: '  ' }).maxStayNights,
    ).toBe(90);
  });
});
