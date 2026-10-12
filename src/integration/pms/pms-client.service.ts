import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios';
import CircuitBreaker from 'opossum';
import type { ApiListResponse, ApiResponse } from './api-response.types';
import { isConfirmationPath } from './confirm-path';
import { PmsRequestError, PmsUnavailableError } from './pms-errors';

/**
 * Client HTTP **résilient** BFF → PMS (Stay-api) — la frontière d'intégration (FR-21, AR-7).
 *
 * Résilience : timeouts (axios, par tentative) + retries backoff exponentiel (réseau/5xx
 * uniquement) + circuit breaker `opossum` (ouverture au seuil, half-open, fallback) +
 * dégradation gracieuse (`PmsUnavailableError`, jamais de crash).
 *
 * Frontière stricte : proxifie un `Bearer` `Customer` fourni par l'appelant, propage
 * `X-Correlation-ID`, pose une `Idempotency-Key` **stable** sur les écritures. N'accède
 * jamais à PostgreSQL et ne persiste aucune vérité métier (le PMS reste la source de vérité).
 * Le `X-Service-Key` n'est jamais posé ici : il transite via `ServiceKeyProvider` (route /confirm).
 */

export const PMS_CLIENT_OPTIONS = 'PMS_CLIENT_OPTIONS';

export interface PmsClientOptions {
  baseUrl: string;
  /** Timeout par tentative (ms). */
  timeoutMs: number;
  /** Nombre de tentatives supplémentaires (ex. 2 ⇒ 3 essais au total). */
  maxRetries: number;
  /** Délai de base du backoff exponentiel (ms). */
  retryBaseDelayMs: number;
  breaker: {
    errorThresholdPercentage: number;
    resetTimeoutMs: number;
    volumeThreshold: number;
  };
}

export interface PmsRequestContext {
  /** JWT `Customer` proxifié en `Authorization: Bearer` (frontière d'auth). */
  bearerToken?: string;
  /** `X-Correlation-ID` propagé jusqu'au PMS (généré à l'entrée BFF — story 1.3). */
  correlationId?: string;
  /** Écritures : clé d'idempotence explicite ; sinon générée et **stable au retry**. */
  idempotencyKey?: string;
  /** En-têtes additionnels (ex. `X-Service-Key` fourni par `ServiceKeyProvider`). */
  headers?: Record<string, string>;
  /**
   * Plafond de retries **pour cet appel** (défaut : `PmsClientOptions.maxRetries`).
   *
   * À poser à `0` sur les **écritures non idempotentes que le PMS n'idempotente pas**
   * (l'en-tête `Idempotency-Key` est envoyé mais Stay-api l'ignore aujourd'hui). Cas réel :
   * `POST /auth/register/customer` (story 2.3) — si la réponse se perd après création, la
   * tentative suivante revient en « Email is already registered. » et le voyageur se voit
   * refuser un compte qui vient d'être créé pour lui, dont personne ne connaît le mot de passe.
   * Un 503 rejouable par l'utilisateur est préférable à cette impasse définitive.
   */
  maxRetries?: number;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Document binaire relayé tel quel (PDF, PNG) — story 3.2. */
export interface PmsBinaryResponse {
  data: Buffer;
  contentType: string;
}

/** Types acceptés pour un document ; le JSON reste accepté pour lire une enveloppe d'erreur. */
const BINARY_ACCEPT = 'application/pdf, image/png, application/json;q=0.5';
const WRITE_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

/** Plafond du délai de backoff par tentative (borne de sûreté anti-emballement). */
const MAX_BACKOFF_MS = 30_000;

@Injectable()
export class PmsClientService {
  private readonly logger = new Logger(PmsClientService.name);
  private readonly http: AxiosInstance;
  private readonly breaker: CircuitBreaker<
    [AxiosRequestConfig, number],
    AxiosResponse
  >;

  constructor(
    @Inject(PMS_CLIENT_OPTIONS) private readonly options: PmsClientOptions,
  ) {
    this.http = axios.create({
      baseURL: options.baseUrl,
      timeout: options.timeoutMs,
      // Le PMS renvoie toujours l'enveloppe ApiResponse ; on interprète nous-mêmes les statuts.
      validateStatus: () => true,
    });

    this.breaker = new CircuitBreaker(
      (config: AxiosRequestConfig, maxRetries: number) =>
        this.executeWithRetries(config, maxRetries),
      {
        // Le timeout est porté par axios (par tentative) ; le breaker ne mesure que les échecs.
        timeout: false,
        errorThresholdPercentage: options.breaker.errorThresholdPercentage,
        resetTimeout: options.breaker.resetTimeoutMs,
        volumeThreshold: options.breaker.volumeThreshold,
        // Les 4xx métier ne sont pas des pannes : ne pas ouvrir le breaker, propager tel quel.
        errorFilter: (err: unknown) => err instanceof PmsRequestError,
      },
    );
    // opossum transmet au fallback les arguments de l'action **puis** l'erreur en dernier.
    this.breaker.fallback((_config: AxiosRequestConfig, _max, err: unknown) => {
      if (
        err instanceof PmsRequestError ||
        err instanceof PmsUnavailableError
      ) {
        throw err;
      }
      throw new PmsUnavailableError(
        'Le PMS est momentanément indisponible.',
        err,
      );
    });
  }

  /** État du circuit breaker (exposé pour diagnostic / futur health check story 1.3). */
  get circuitOpen(): boolean {
    return this.breaker.opened;
  }

  /** Libère les timers internes du circuit breaker (arrêt gracieux / tests). */
  shutdown(): void {
    this.breaker.shutdown();
  }

  async get<T>(path: string, ctx?: PmsRequestContext): Promise<ApiResponse<T>> {
    const res = await this.request('GET', path, undefined, ctx);
    return this.toApiResponse<T>(res);
  }

  /**
   * Lecture d'un **document binaire** (PDF, PNG) — story 3.2 (B1).
   *
   * ⚠️ Sur un non-2xx, le PMS répond une enveloppe **JSON** : elle est décodée et suit le chemin
   * d'erreur normal (`PmsRequestError`), sinon une 404 métier remonterait au navigateur comme un
   * « PDF corrompu ». Lecture idempotente : les retries par défaut s'appliquent.
   */
  async getBinary(
    path: string,
    ctx?: PmsRequestContext,
  ): Promise<PmsBinaryResponse> {
    const res = await this.request('GET', path, undefined, ctx, {
      responseType: 'arraybuffer',
      accept: BINARY_ACCEPT,
    });
    const contentType = headerValue(res.headers, 'content-type');
    if (!contentType || /json/i.test(contentType)) {
      // Un 2xx sans type exploitable (ou une enveloppe JSON) n'est pas un document : relayer ces
      // octets ferait télécharger au voyageur un fichier illisible.
      throw new PmsUnavailableError(
        `Réponse PMS inattendue (document attendu, statut ${res.status}).`,
      );
    }
    return { data: toBuffer(res.data), contentType };
  }

  async getList<T>(
    path: string,
    ctx?: PmsRequestContext,
  ): Promise<ApiListResponse<T>> {
    const res = await this.request('GET', path, undefined, ctx);
    return this.toApiListResponse<T>(res);
  }

  async post<T>(
    path: string,
    body?: unknown,
    ctx?: PmsRequestContext,
  ): Promise<ApiResponse<T>> {
    const res = await this.request('POST', path, body, ctx);
    return this.toApiResponse<T>(res);
  }

  async put<T>(
    path: string,
    body?: unknown,
    ctx?: PmsRequestContext,
  ): Promise<ApiResponse<T>> {
    const res = await this.request('PUT', path, body, ctx);
    return this.toApiResponse<T>(res);
  }

  async patch<T>(
    path: string,
    body?: unknown,
    ctx?: PmsRequestContext,
  ): Promise<ApiResponse<T>> {
    const res = await this.request('PATCH', path, body, ctx);
    return this.toApiResponse<T>(res);
  }

  async delete<T>(
    path: string,
    ctx?: PmsRequestContext,
  ): Promise<ApiResponse<T>> {
    const res = await this.request('DELETE', path, undefined, ctx);
    return this.toApiResponse<T>(res);
  }

  private async request(
    method: HttpMethod,
    path: string,
    body: unknown,
    ctx: PmsRequestContext = {},
    binary?: { responseType: 'arraybuffer'; accept: string },
  ): Promise<AxiosResponse> {
    // Config construite UNE fois → l'Idempotency-Key reste stable sur toutes les tentatives de retry.
    const config = this.buildConfig(method, path, body, ctx);
    if (binary) {
      config.responseType = binary.responseType;
      config.headers = { ...config.headers, Accept: binary.accept };
    }
    try {
      return await this.breaker.fire(config, this.resolveMaxRetries(ctx));
    } catch (err) {
      if (
        err instanceof PmsRequestError ||
        err instanceof PmsUnavailableError
      ) {
        throw err;
      }
      throw new PmsUnavailableError("Échec de l'appel au PMS.", err);
    }
  }

  private buildConfig(
    method: HttpMethod,
    path: string,
    body: unknown,
    ctx: PmsRequestContext,
  ): AxiosRequestConfig {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(ctx.headers ?? {}),
    };
    if (ctx.bearerToken) {
      headers.Authorization = `Bearer ${ctx.bearerToken}`;
    }
    if (ctx.correlationId) {
      headers['X-Correlation-ID'] = ctx.correlationId;
    }
    if (WRITE_METHODS.has(method)) {
      // Écriture : clé d'idempotence stable (fournie ou générée) — réutilisée à chaque retry.
      headers['Idempotency-Key'] = ctx.idempotencyKey ?? randomUUID();
      headers['Content-Type'] = 'application/json';
    }
    // Frontière AR-8 appliquée à l'envoi réel : X-Service-Key uniquement vers /confirm,
    // quel que soit le chemin qui a produit l'en-tête (défense en profondeur).
    if (headers['X-Service-Key'] !== undefined && !isConfirmationPath(path)) {
      throw new Error(
        `X-Service-Key ne peut cibler que /reservations/{id}/confirm (reçu: "${path}").`,
      );
    }
    return { method, url: path, data: body, headers };
  }

  /**
   * Plafond de retries effectif : override d'appel s'il est fourni et exploitable, sinon la
   * configuration globale. Une valeur négative ou non finie retombe sur le défaut (une faute de
   * frappe ne doit pas silencieusement désactiver la résilience de tout le BFF).
   */
  private resolveMaxRetries(ctx: PmsRequestContext): number {
    const override = ctx.maxRetries;
    return override !== undefined && Number.isInteger(override) && override >= 0
      ? override
      : this.options.maxRetries;
  }

  /**
   * Exécute la requête avec retries backoff. Retry uniquement sur erreurs réseau/timeout et 5xx.
   * 4xx métier → `PmsRequestError` (non retryé). Retries épuisés → `PmsUnavailableError`.
   */
  private async executeWithRetries(
    config: AxiosRequestConfig,
    maxRetries: number,
  ): Promise<AxiosResponse> {
    let lastCause: unknown;
    // Dernier 5xx RÉPONDU (statut + corps) : la confirmation y porte un motif métier (#152).
    let lastResponse: { status: number; body: unknown } | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await this.delay(this.backoffDelay(attempt));
      }

      let res: AxiosResponse;
      try {
        res = await this.http.request(config);
      } catch (err) {
        // Erreur réseau / timeout → retryable.
        lastCause = err;
        lastResponse = undefined;
        this.logger.warn(
          `PMS ${config.method ?? '?'} ${config.url ?? '?'} — échec réseau (tentative ${attempt + 1}/${maxRetries + 1})`,
        );
        continue;
      }

      if (res.status >= 500) {
        lastCause = new Error(`Le PMS a répondu ${res.status}`);
        lastResponse = { status: res.status, body: decodeBody(res.data) };
        this.logger.warn(
          `PMS ${config.method ?? '?'} ${config.url ?? '?'} — ${res.status} (tentative ${attempt + 1}/${maxRetries + 1})`,
        );
        continue;
      }

      if (res.status >= 400) {
        // 4xx métier : non retryable, non-panne (laissé passer par l'errorFilter du breaker).
        throw this.toRequestError(res);
      }

      return res;
    }

    throw new PmsUnavailableError(
      'Le PMS ne répond pas après plusieurs tentatives.',
      lastCause,
      lastResponse,
    );
  }

  /** Normalise une réponse succès mono-ressource : gère 204/corps vide, rejette un corps non-enveloppe. */
  private toApiResponse<T>(res: AxiosResponse): ApiResponse<T> {
    const body: unknown = res.data;
    if (body === '' || body === null || body === undefined) {
      return { success: true, data: undefined as T };
    }
    if (typeof body !== 'object') {
      throw new PmsUnavailableError(
        `Réponse PMS inattendue (corps non-enveloppe, statut ${res.status}).`,
      );
    }
    return body as ApiResponse<T>;
  }

  /** Normalise une réponse succès paginée : 204/corps vide → liste vide ; corps non-enveloppe → panne. */
  private toApiListResponse<T>(res: AxiosResponse): ApiListResponse<T> {
    const body: unknown = res.data;
    if (body === '' || body === null || body === undefined) {
      return {
        success: true,
        data: [],
        pagination: {
          page: 1,
          pageSize: 0,
          totalCount: 0,
          totalPages: 0,
          hasPreviousPage: false,
          hasNextPage: false,
        },
      };
    }
    if (typeof body !== 'object') {
      throw new PmsUnavailableError(
        `Réponse PMS inattendue (corps non-enveloppe, statut ${res.status}).`,
      );
    }
    return body as ApiListResponse<T>;
  }

  private toRequestError(res: AxiosResponse): PmsRequestError {
    // Une lecture binaire reçoit ses erreurs en octets : on les décode avant d'y chercher l'enveloppe.
    const body: unknown = decodeBody(res.data);
    let message = `Le PMS a renvoyé le statut ${res.status}.`;
    let errors: Record<string, string[]> | string[] | undefined;

    if (body !== null && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      if (typeof record.message === 'string' && record.message.length > 0) {
        message = record.message;
      }
      if (
        Array.isArray(record.errors) ||
        (record.errors !== null && typeof record.errors === 'object')
      ) {
        errors = record.errors as Record<string, string[]> | string[];
      }
    }

    return new PmsRequestError(message, res.status, {
      errors,
      responseBody: body,
    });
  }

  /** Backoff exponentiel avec gigue : base·2^(n-1) + jitter[0..base). */
  private backoffDelay(attempt: number): number {
    const base = this.options.retryBaseDelayMs;
    const exponential = Math.min(
      base * Math.pow(2, attempt - 1),
      MAX_BACKOFF_MS,
    );
    const jitter = Math.floor(Math.random() * base);
    return exponential + jitter;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Corps d'une réponse, décodé s'il est arrivé en octets (`responseType: 'arraybuffer'`) : une
 * enveloppe JSON redevient un objet, tout autre contenu une chaîne. Les corps déjà décodés par
 * axios passent inchangés.
 */
function decodeBody(data: unknown): unknown {
  if (!Buffer.isBuffer(data) && !(data instanceof ArrayBuffer)) {
    return data;
  }
  const text = toBuffer(data).toString('utf-8');
  if (text.length === 0) {
    return '';
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (typeof data === 'string') {
    return Buffer.from(data, 'latin1');
  }
  return Buffer.alloc(0);
}

/** Valeur d'un en-tête de réponse axios, quelle que soit sa forme (objet brut ou `AxiosHeaders`). */
function headerValue(headers: unknown, name: string): string | null {
  if (headers === null || typeof headers !== 'object') {
    return null;
  }
  const raw: unknown = (headers as Record<string, unknown>)[name];
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  return null;
}
