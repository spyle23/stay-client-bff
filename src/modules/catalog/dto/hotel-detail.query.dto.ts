import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Query du détail hôtel (story 1.9). Les dates + voyageurs sont **optionnels** (la page hôtel est
 * ouvrable sans contexte de séjour — lien « nu ») : leur validité fine (format, ordre) est portée
 * par le **service**, qui **retombe** sur un affichage prix/nuit si elle échoue (Décision 4/AC-9),
 * plutôt que de renvoyer 400 — la page hôtel doit toujours se rendre.
 *
 * ⚠️ Tout param **non déclaré** ici est rejeté 400 par le `ValidationPipe` global
 * (`forbidNonWhitelisted`) — cf. bug Phase 3 de 1.7. Le front n'émet que `checkInDate`,
 * `checkOutDate`, `guests`.
 */
export class HotelDetailQueryDto {
  @IsOptional()
  @IsString()
  checkInDate?: string;

  @IsOptional()
  @IsString()
  checkOutDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  guests?: number;
}
