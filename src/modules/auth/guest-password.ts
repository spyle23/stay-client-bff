import { randomInt } from 'node:crypto';

/**
 * Mot de passe du **compte léger** provisionné au Checkout invité (story 2.3 — FR-8).
 *
 * Le PMS n'offre aucun checkout anonyme : réserver exige le rôle `Customer`
 * (`RoomReservationsController.CreateReservation`, `[RequireRole(UserRole.Customer)]`). Le BFF
 * crée donc un compte via `POST /auth/register/customer`, qui **impose un mot de passe** — d'où
 * ce générateur.
 *
 * **Invariants de sécurité :**
 * - le mot de passe est tiré au hasard **cryptographiquement** puis oublié : ni stocké, ni logué,
 *   ni renvoyé au navigateur, ni dérivé d'un secret serveur. Une dérivation déterministe
 *   (`HMAC(secret, email)`) permettrait de « reconnecter » un invité — donc à n'importe qui de
 *   saisir l'email d'autrui pour ouvrir sa session : c'est un contournement d'authentification,
 *   écarté explicitement par la story ;
 * - conséquence assumée : le compte léger n'est pas connectable tant que le « mot de passe
 *   oublié » (story 4.1) ou le lien de gestion signé (FR-18) ne sont pas livrés.
 *
 * **Politique PMS déclarée** (`RegisterCustomerRequestValidator.cs:26-32`) : ≥ 8 caractères, au
 * moins une majuscule, une minuscule, un chiffre et un caractère spécial.
 *
 * ⚠️ Ce validateur est **enregistré mais jamais invoqué** : `DependencyInjection.cs:13` appelle
 * `AddValidatorsFromAssembly`, mais le PMS n'a ni `AddFluentValidationAutoValidation`, ni filtre
 * d'action, et `AuthService` ne reçoit aucun `IValidator` — aucune de ces règles n'est appliquée
 * aujourd'hui. On les satisfait **par construction** malgré tout : c'est la politique déclarée du
 * PMS, le jour où elle sera câblée un tirage uniforme naïf la violerait environ une fois sur 30,
 * et le coût de la garantir est nul.
 */

const UPPERCASE = 'ABCDEFGHIJKLMNPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
/** Spéciaux volontairement restreints : rien qui doive être échappé en JSON, log ou URL. */
const SPECIALS = '!@#$%^&*_+=?-';
const ALPHABET = UPPERCASE + LOWERCASE + DIGITS + SPECIALS;

/** Bien au-delà du minimum PMS (8) : ce secret n'est jamais mémorisé par un humain. */
export const GUEST_PASSWORD_LENGTH = 24;

/** Miroir de la politique PMS déclarée — sert d'assertion de non-régression du générateur. */
export function satisfiesPmsPasswordPolicy(password: string): boolean {
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^a-zA-Z0-9]/.test(password)
  );
}

function pick(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)];
}

/**
 * Tire un mot de passe **conforme par construction** : une occurrence garantie de chaque classe
 * requise, le reste tiré dans l'alphabet complet, puis mélange de Fisher-Yates non biaisé
 * (`randomInt`) pour que les positions des classes garanties ne soient pas prévisibles.
 */
export function generateGuestPassword(): string {
  const chars = [
    pick(UPPERCASE),
    pick(LOWERCASE),
    pick(DIGITS),
    pick(SPECIALS),
    ...Array.from({ length: GUEST_PASSWORD_LENGTH - 4 }, () => pick(ALPHABET)),
  ];

  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}
