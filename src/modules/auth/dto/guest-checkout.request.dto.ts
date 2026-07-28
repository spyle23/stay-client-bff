import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Corps de `POST /api/v1/auth/guest` — **Checkout invité** (story 2.3, FR-8).
 *
 * ⚠️ Le `ValidationPipe` global est en `forbidNonWhitelisted` : tout champ non déclaré ici
 * (`password`, `role`, `specialRequests`…) fait échouer la requête en 400. C'est volontaire —
 * le mot de passe du compte léger est **généré par le BFF**, jamais fourni par le navigateur.
 *
 * Les bornes reproduisent celles de `RegisterCustomerRequestValidator.cs`, **qui n'est jamais
 * exécuté côté PMS** (enregistré via `AddValidatorsFromAssembly`, mais sans auto-validation ni
 * filtre d'action). Ce DTO est donc le **seul** rempart réel : sans lui, un champ hors bornes
 * atteindrait la contrainte `varchar` de PostgreSQL et ressortirait en **500** — que le BFF
 * traduirait en 503, message de panne à l'appui, pour une simple faute de saisie.
 */
export class GuestCheckoutRequestDto {
  /**
   * Normalisé en minuscules, comme `LoginRequestDto` : le PMS stocke l'email en
   * `ToLowerInvariant()` à l'inscription mais le compare **brut** à la connexion. Sans cette
   * normalisation, un invité inscrit via « Voyageur@Example.com » ne pourrait jamais se
   * reconnecter, et la détection de collision dépendrait de la casse saisie.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Adresse email invalide.' })
  @MaxLength(255, { message: 'Adresse email trop longue.' })
  email!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'Prénom requis.' })
  @MaxLength(100, { message: 'Prénom trop long.' })
  firstName!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'Nom requis.' })
  @MaxLength(100, { message: 'Nom trop long.' })
  lastName!: string;

  /**
   * Téléphone : requis par FR-8 (« email + nom + téléphone ») et **seul endroit** où il peut être
   * enregistré — le PMS ne l'accepte qu'à l'inscription (`CreateRoomReservationDto` ne porte
   * aucune coordonnée, et aucun endpoint de profil client n'existe).
   *
   * Motif volontairement permissif (formats internationaux, séparateurs usuels) : le BFF n'a pas
   * de bibliothèque de numérotation et ne doit pas rejeter un numéro valide qu'il ne connaît pas.
   * La borne de 20 caractères est celle du PMS (`Phone` max 20).
   *
   * ⚠️ Le quantificateur porte sur les **chiffres** (lookahead), pas sur les caractères : un
   * `{6,}` naïf accepterait `"------"` ou `"(  )  "` — un `Customer` au téléphone inexploitable,
   * créé depuis une route publique, dans le seul point de saisie du téléphone de tout le système.
   * L'alphabet exclut `\s` au profit de l'espace littéral : un `\n` en milieu de numéro
   * ressortirait dans les emails et PDF produits par le PMS.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'Téléphone requis.' })
  @MaxLength(20, { message: 'Téléphone trop long.' })
  @Matches(/^(?=(?:\D*\d){6,})\+?[\d ().-]+$/, {
    message: 'Numéro de téléphone invalide.',
  })
  phone!: string;
}
