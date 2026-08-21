/**
 * Demandes spéciales & langue de communication — **bornes et normalisation** (story 2.5, FR-10).
 *
 * ## Pourquoi ces règles vivent dans le BFF
 *
 * `Stay-api` n'a **aucun** validateur pour `CreateRoomReservationDto` (le dossier `Validators/`
 * ne couvre que `Auth/`, `Users/` et les réglages d'administration). La seule borne réelle est la
 * colonne `RoomReservation.SpecialRequests` en `character varying(2000)`
 * (`RoomReservationConfiguration.cs:37-38`). Un texte plus long ne produirait donc **pas** un 400
 * lisible mais une erreur Npgsql à l'écriture — soit un **500** au beau milieu du tunnel, sur la
 * seule requête qui immobilise une vraie chambre.
 *
 * Le BFF est par conséquent le **seul** garde-fou : il normalise, puis le DTO refuse au-delà de la
 * borne (`@MaxLength`), avant que quoi que ce soit ne parte vers le PMS.
 *
 * ## Ce que la normalisation fait — et ne fait pas
 *
 * Elle **ne tronque jamais** : amputer en silence enverrait à la réception une demande incomplète
 * que le voyageur croit transmise en entier. Dépasser la borne est un **refus** (400), pas une
 * mutilation. Elle n'échappe rien non plus : ce texte n'est jamais rendu en HTML — ni par le PMS
 * (`ReservationVariableModel` ne le porte pas, il n'atteint donc aucun gabarit d'email), ni par le
 * back-office (`Stay/` le rend via `<p>{data.specialRequests}</p>`, échappé par React). Ajouter un
 * assainisseur HTML ici abîmerait un texte destiné à être **lu par un humain**.
 *
 * Elle neutralise en revanche les caractères **invisibles** : contrôles C0/C1, mais aussi les
 * caractères de formatage Unicode (bidi `U+202E`, zero-width `U+200B`…). Ils ne servent à rien dans
 * une demande d'hôtel et permettent d'afficher à la réception un texte différent de celui qui est
 * stocké. Ils sont remplacés par une **espace**, jamais retirés « sèchement » : un retrait collerait
 * les mots (« Chambre<CTRL>calme » → « Chambrecalme »).
 *
 * @see story 2.5 · FR-10 · NFR-5 (durcissement) · AR-12 (contrat)
 */

/**
 * Longueur maximale d'une demande spéciale, mesurée après normalisation.
 *
 * ⚠️ **En unités UTF-16**, pas en caractères — c'est ce que comptent `String.prototype.length` et
 * `@MaxLength`, et la formulation « en caractères » était fausse (revue 2ᵉ passe, F11). L'écart est
 * réel : 500 emoji font `.length === 1000`, et un `e` + U+0301 décomposé (copier-coller depuis
 * macOS) vaut 2 unités pour un seul glyphe.
 *
 * Cet écart est **sans danger** dans ce sens-là : une unité UTF-16 vaut au plus un point de code,
 * donc la longueur mesurée ici majore toujours le nombre de caractères que PostgreSQL comptera.
 * 1000 unités ne peuvent jamais dépasser 1000 caractères dans une colonne qui en accepte 2000.
 *
 * Volontairement **non configurable** : le front affiche cette limite dans un compteur
 * (`booking-preferences.tsx`) ; une valeur variable d'un environnement à l'autre ferait mentir
 * l'interface, et le voyageur découvrirait le refus au moment de réserver.
 */
export const SPECIAL_REQUESTS_MAX_LENGTH = 1000;

/**
 * Langues de communication proposées au voyageur.
 *
 * ⚠️ Intersection **stricte** des locales du front (`stay-client/src/i18n/config.ts` : `fr`, `en`)
 * et des `SupportedLanguages` du moteur d'emails du PMS (`EmailOutboxProcessor.cs:48` : `["fr","en"]`,
 * comparaison `StringComparer.Ordinal`). Proposer autre chose — ou une locale complète type
 * `fr-FR` — produirait un repli silencieux sur « fr » le jour où D10 sera livré.
 */
export const COMMUNICATION_LOCALES = ['fr', 'en'] as const;

export type CommunicationLocale = (typeof COMMUNICATION_LOCALES)[number];

/** Garde de type sur les langues de communication (casse et forme exactes). */
export function isCommunicationLocale(
  value: unknown,
): value is CommunicationLocale {
  return (
    typeof value === 'string' &&
    (COMMUNICATION_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Caractères **invisibles** neutralisés : contrôles C0/C1 (`\p{Cc}`) et caractères de formatage
 * Unicode (`\p{Cf}` — bidi overrides, zero-width, BOM…). Le retour à la ligne est traité à part.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/** Fins de ligne Windows (`\r\n`) et CR isolés, ramenés à un `\n` unique. */
const LINE_ENDINGS = /\r\n?/g;

/**
 * Normalise une demande spéciale : `null` si elle est vide de sens, la chaîne nettoyée sinon.
 *
 * Ne **lève jamais** et ne tronque jamais — la borne de longueur est portée par `@MaxLength` sur le
 * DTO, qui produit un 400 propre. Lever ici, depuis un `@Transform`, remonterait en **500**.
 *
 * Une valeur non textuelle est renvoyée **telle quelle** : la refuser proprement est le travail de
 * `@IsString`. La convertir fabriquerait une demande spéciale (« 42 ») à partir d'une requête
 * malformée.
 *
 * `null` (et non `''`) pour une saisie vide : `''` serait persisté tel quel par le PMS, produisant
 * une demande spéciale « vide » là où il ne devrait y en avoir **aucune**.
 */
export function normalizeSpecialRequests(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value ?? null;
  }
  const normalized = value
    .replace(LINE_ENDINGS, '\n')
    // Espace, pas suppression : un retrait sec collerait les mots de part et d'autre.
    .replace(INVISIBLE, (char) => (char === '\n' ? char : ' '))
    .trim();
  return normalized.length > 0 ? normalized : null;
}
