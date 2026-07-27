import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Corps de `POST /api/v1/auth/login` (story 2.1, FR-19).
 *
 * ⚠️ Le `ValidationPipe` global est en `forbidNonWhitelisted` : tout champ non déclaré ici
 * (`rememberMe`, `role`…) fait échouer la requête en 400. C'est volontaire — le BFF ne
 * relaie au PMS que ce qu'il a validé.
 *
 * Le PMS reste le validateur autoritatif des identifiants ; ces règles ne font que rejeter
 * les requêtes manifestement malformées sans consommer d'appel PMS. (Aucune limitation de
 * débit n'existe encore sur cette route — elle relève de la story 6.1.)
 */
export class LoginRequestDto {
  /**
   * Normalisé en minuscules : le PMS stocke l'email en `ToLowerInvariant()` à l'inscription
   * (`AuthService.RegisterCustomerAsync`) mais le compare **brut** à la connexion
   * (`u.Email == request.Email`, sensible à la casse en PostgreSQL). Sans cette normalisation,
   * un voyageur qui saisit « Voyageur@Example.com » — autocomplétion iOS, copier-coller — ne
   * peut plus jamais se connecter, avec un message qui lui laisse croire à un mot de passe faux.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'Adresse email invalide.' })
  @MaxLength(320, { message: 'Adresse email trop longue.' })
  email!: string;

  @IsString()
  @IsNotEmpty({ message: 'Mot de passe requis.' })
  // Borne haute : évite qu'un corps volumineux atteigne le PMS (le hachage est côté PMS).
  @MaxLength(200, { message: 'Mot de passe trop long.' })
  password!: string;
}
