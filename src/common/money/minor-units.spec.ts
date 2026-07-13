import { minorUnitExponent, toMinorUnits } from './minor-units';

describe('minor-units', () => {
  it('dérive l’exposant réel de la devise (pas un ×100 universel)', () => {
    expect(minorUnitExponent('EUR')).toBe(2);
    expect(minorUnitExponent('USD')).toBe(2);
    expect(minorUnitExponent('MGA')).toBe(0); // Madagascar — 0 décimale
    expect(minorUnitExponent('JPY')).toBe(0);
    expect(minorUnitExponent('KWD')).toBe(3);
  });

  it('retombe sûrement sur 2 pour un code devise invalide, sans lever', () => {
    expect(() => minorUnitExponent('INVALID_CODE')).not.toThrow();
    expect(minorUnitExponent('INVALID_CODE')).toBe(2);
  });

  it('convertit un décimal PMS en unités mineures selon la devise', () => {
    expect(toMinorUnits(120, 'EUR')).toBe(12000); // ×100
    expect(toMinorUnits(12000, 'MGA')).toBe(12000); // ×1 (sinon 1 200 000 affiché !)
    expect(toMinorUnits(12, 'KWD')).toBe(12000); // ×1000
  });
});
