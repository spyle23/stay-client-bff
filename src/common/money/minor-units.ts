/**
 * Conversion vers les **unités mineures entières** d'une devise (AR-12 : « argent en unités
 * mineures entières (cents), devise toujours transportée »).
 *
 * ⚠️ « cents » n'implique **pas** ×100 : l'exposant dépend de la devise. La page hôtel (story 1.9)
 * affiche la **devise propre de l'Hôtel**, potentiellement quelconque — et l'exposant réel doit être
 * utilisé des DEUX côtés du fil, sinon le montant est faux d'un facteur 10^n :
 *   - EUR/USD → 2 décimales (×100)
 *   - **MGA**, JPY, XOF, KRW → **0 décimale** (×1)
 *   - BHD, KWD, TND → 3 décimales (×1000)
 *
 * Le front décode symétriquement (`stay-client/src/lib/currency.ts#minorUnitExponent`).
 */

/** Chemin rapide (évite de construire un `Intl.NumberFormat` pour les devises courantes). */
const FAST_PATH: Record<string, number> = { EUR: 2, USD: 2 };

const derivedCache = new Map<string, number>();

/**
 * Nombre de décimales (exposant d'unités mineures) de la devise, dérivé de l'ICU. Un code devise
 * invalide/inconnu retombe **sûrement** sur 2, sans jamais lever.
 */
export function minorUnitExponent(currency: string): number {
  const fast = FAST_PATH[currency];
  if (fast !== undefined) {
    return fast;
  }
  const cached = derivedCache.get(currency);
  if (cached !== undefined) {
    return cached;
  }
  let exponent = 2;
  try {
    const resolved = new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
    }).resolvedOptions();
    if (typeof resolved.maximumFractionDigits === 'number') {
      exponent = resolved.maximumFractionDigits;
    }
  } catch {
    exponent = 2;
  }
  derivedCache.set(currency, exponent);
  return exponent;
}

/** Convertit un montant **décimal** (tel que renvoyé par le PMS) en unités mineures entières. */
export function toMinorUnits(amount: number, currency: string): number {
  return Math.round(amount * 10 ** minorUnitExponent(currency));
}
