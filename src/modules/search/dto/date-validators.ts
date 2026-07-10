import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse une date-only `AAAA-MM-JJ` en timestamp **UTC minuit**, ou `null` si le format
 * ou la date calendaire est invalide (ex. `2026-02-30`). Référentiel UTC aligné sur le PMS
 * (comparaisons contre `DateTime.UtcNow`).
 */
export function parseDateOnlyUtc(value: string): number | null {
  if (!DATE_ONLY.test(value)) {
    return null;
  }
  const [year, month, day] = value.split('-').map(Number);
  const ts = Date.UTC(year, month - 1, day);
  const date = new Date(ts);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return ts;
}

/** Aujourd'hui à minuit UTC (borne du « pas dans le passé »). */
export function todayUtcMidnight(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** Le champ doit être une date-only `AAAA-MM-JJ` calendaire valide. */
export function IsDateOnly(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isDateOnly',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && parseDateOnlyUtc(value) !== null;
        },
        defaultMessage(): string {
          return `${propertyName} doit être une date valide au format AAAA-MM-JJ.`;
        },
      },
    });
  };
}

/** Le champ (date-only) ne doit pas être dans le passé (référentiel UTC). */
export function IsNotPastDate(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isNotPastDate',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') {
            return false;
          }
          const ts = parseDateOnlyUtc(value);
          return ts !== null && ts >= todayUtcMidnight();
        },
        defaultMessage(): string {
          return `${propertyName} ne peut pas être dans le passé.`;
        },
      },
    });
  };
}

/** Le champ (date-only) doit être strictement postérieur à une autre propriété date-only. */
export function IsAfterDateProperty(
  property: string,
  options?: ValidationOptions,
) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isAfterDateProperty',
      target: object.constructor,
      propertyName,
      constraints: [property],
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (typeof value !== 'string') {
            return false;
          }
          const [otherProperty] = args.constraints as string[];
          const otherRaw = (args.object as Record<string, unknown>)[
            otherProperty
          ];
          if (typeof otherRaw !== 'string') {
            return false;
          }
          const end = parseDateOnlyUtc(value);
          const start = parseDateOnlyUtc(otherRaw);
          return end !== null && start !== null && end > start;
        },
        defaultMessage(args: ValidationArguments): string {
          const [otherProperty] = args.constraints as string[];
          return `${propertyName} doit être postérieure à ${otherProperty}.`;
        },
      },
    });
  };
}
