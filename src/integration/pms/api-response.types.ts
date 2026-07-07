/**
 * Enveloppes de réponse du PMS (Stay-api), réexposées **à l'identique** par le BFF (AR-12).
 *
 * Invariants de contrat (à ne jamais casser) :
 * - JSON camelCase ;
 * - montants en **unités mineures entières** (cents) — jamais de flottant, devise toujours transportée ;
 * - dates **ISO 8601 UTC** ;
 * - `null` (jamais `undefined`) dans les payloads.
 *
 * Formes alignées sur `Stay/src/types/api.ts` (front PMS) et sur la sérialisation Stay-api.
 */

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

/** Réponse mono-ressource : `{ data, success, message?, errors? }`. */
export interface ApiResponse<T> {
  data: T;
  success: boolean;
  message?: string;
  errors?: Record<string, string[]>;
}

/** Réponse paginée : `{ success, data[], pagination, message?, errors? }`. */
export interface ApiListResponse<T> {
  success: boolean;
  data: T[];
  pagination: PaginationMeta;
  message?: string;
  errors?: string[];
}
