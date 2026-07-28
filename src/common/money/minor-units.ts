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

import { Logger } from '@nestjs/common';

const logger = new Logger('MinorUnits');

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
    // Code hors ISO 4217 (ou vide) : repli sûr sur 2 décimales, mais **jamais en silence** — un
    // montant converti avec le mauvais exposant est faux d'un facteur 10^n, et le symptôme
    // n'apparaîtrait qu'à l'écran (revue 2.2).
    exponent = 2;
    logger.warn(
      `Devise « ${currency} » inconnue de l'ICU : exposant d'unités mineures replié sur 2. ` +
        `Les montants exprimés dans cette devise peuvent être faux d'un facteur 10^n.`,
    );
  }
  derivedCache.set(currency, exponent);
  return exponent;
}

/** Convertit un montant **décimal** (tel que renvoyé par le PMS) en unités mineures entières. */
export function toMinorUnits(amount: number, currency: string): number {
  return Math.round(amount * 10 ** minorUnitExponent(currency));
}

/**
 * Vrai si `amount` porte **plus de décimales que la devise n'en admet** (ex. `84.005` en EUR).
 *
 * Pourquoi c'est important (story 2.2) : le BFF arrondit le tarif **puis** multiplie par les nuits
 * (`toMinorUnits(prix) × nuits`) — c'est ce qui garde le total affiché cohérent avec le prix/nuit
 * affiché. Le PMS, lui, multiplie en `decimal` **puis** persiste
 * (`RoomReservationService.CreateAsync` : `room.Price * numberOfNights`). Tant que le tarif tient
 * dans l'exposant de la devise, les deux coïncident exactement ; au-delà, ils peuvent diverger de
 * quelques unités mineures — et le voyageur verrait un total annoncé différent du total facturé.
 *
 * Cette fonction ne corrige rien : elle rend le cas **détectable** (log) au lieu de silencieux.
 * La vérification bloquante (comparer le total annoncé au total renvoyé par le PMS à la création)
 * relève de la story 2.4.
 */
export function hasSubMinorPrecision(
  amount: number,
  currency: string,
): boolean {
  if (!Number.isFinite(amount)) {
    return false;
  }
  const scaled = amount * 10 ** minorUnitExponent(currency);
  // Tolérance de représentation IEEE-754 : `84.1 * 100 = 8409.999...` n'est pas une vraie
  // sous-précision. Le seuil reste très inférieur à une unité mineure réellement perdue.
  return Math.abs(scaled - Math.round(scaled)) > 1e-6;
}
