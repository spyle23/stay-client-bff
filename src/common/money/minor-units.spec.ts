import {
  hasSubMinorPrecision,
  minorUnitExponent,
  toMinorUnits,
} from './minor-units';

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

  describe('hasSubMinorPrecision (story 2.2)', () => {
    it('ne signale rien pour un tarif exprimable dans la devise', () => {
      expect(hasSubMinorPrecision(84, 'EUR')).toBe(false);
      expect(hasSubMinorPrecision(84.5, 'EUR')).toBe(false);
      expect(hasSubMinorPrecision(84.05, 'EUR')).toBe(false);
      expect(hasSubMinorPrecision(12000, 'MGA')).toBe(false);
      expect(hasSubMinorPrecision(12.345, 'KWD')).toBe(false);
    });

    /**
     * Cas qui fait diverger le total du récapitulatif (arrondi PUIS × nuits) de celui que le PMS
     * calculera à la création (× nuits en `decimal` PUIS arrondi).
     */
    it('signale un tarif plus précis que la devise', () => {
      expect(hasSubMinorPrecision(84.005, 'EUR')).toBe(true);
      expect(hasSubMinorPrecision(12000.5, 'MGA')).toBe(true); // MGA = 0 décimale
      expect(hasSubMinorPrecision(12.3456, 'KWD')).toBe(true); // KWD = 3 décimales
    });

    /** `84.1 × 100 = 8409.999…` en IEEE-754 : ce n'est PAS une sous-précision réelle. */
    it('ne confond pas la représentation flottante avec une sous-précision', () => {
      expect(hasSubMinorPrecision(84.1, 'EUR')).toBe(false);
      expect(hasSubMinorPrecision(1.005, 'KWD')).toBe(false);
      expect(hasSubMinorPrecision(29.97, 'EUR')).toBe(false);
    });

    it('reste muet sur une valeur non finie (jamais de faux signal)', () => {
      expect(hasSubMinorPrecision(Number.NaN, 'EUR')).toBe(false);
      expect(hasSubMinorPrecision(Number.POSITIVE_INFINITY, 'EUR')).toBe(false);
    });
  });
});
