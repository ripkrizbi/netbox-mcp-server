/**
 * Thin Axios-based NetBox REST client.
 *
 * All tools go through the singleton returned by `getClient()`, which reads
 * config from env at first use and applies the auth header + TLS options.
 */

import axios, { AxiosError, AxiosInstance } from "axios";
import https from "node:https";

import { loadConfig, NetBoxConfig } from "./config.js";
import { DEFAULT_TIMEOUT_MS } from "./constants.js";
import { authorizationHeader } from "./auth.js";

let cachedClient: NetBoxClient | null = null;

export interface PaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export class NetBoxClient {
  readonly config: NetBoxConfig;
  private readonly http: AxiosInstance;

  constructor(config: NetBoxConfig) {
    this.config = config;
    this.http = axios.create({
      baseURL: config.apiUrl,
      timeout: DEFAULT_TIMEOUT_MS,
      headers: {
        Authorization: authorizationHeader(config.token),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      // Axios serialises an array as `name[]=a&name[]=b`. NetBox's filters
      // expect the parameter REPEATED — `name=a&name=b` — and, worse, NetBox
      // silently ignores a parameter it does not recognise and returns the
      // complete unfiltered collection. So `name[]=` did not error: it dropped
      // the filter and answered with everything, which a caller cannot tell
      // from a genuinely unfiltered match.
      //
      // The local filter-name validation does not catch this. The caller sends
      // `name`, which is a real parameter, and the corruption happens after
      // validation, during serialisation.
      paramsSerializer: { serialize: repeatParams },
      httpsAgent: config.insecure
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined,
      // Reject only on >= 500 so we can surface NetBox's error body verbatim.
      validateStatus: (status) => status < 500,
    });
  }

  /**
   * GET /<endpoint>/ optionally with query params. `endpoint` should NOT have
   * leading or trailing slashes, e.g. "dcim/sites".
   */
  async list<T>(
    endpoint: string,
    params: Record<string, unknown> = {},
  ): Promise<PaginatedResponse<T>> {
    const response = await this.http.get(`/${endpoint}/`, {
      params: cleanParams(params),
    });
    if (response.status >= 400) {
      throw axiosLikeError(response);
    }
    return response.data as PaginatedResponse<T>;
  }

  /** GET /<endpoint>/<id>/ */
  async get<T>(endpoint: string, id: number | string): Promise<T> {
    const response = await this.http.get(`/${endpoint}/${id}/`);
    if (response.status >= 400) {
      throw axiosLikeError(response);
    }
    return response.data as T;
  }

  /** POST /<endpoint>/ with a JSON body. */
  async create<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.http.post(`/${endpoint}/`, cleanParams(body));
    if (response.status >= 400) {
      throw axiosLikeError(response);
    }
    return response.data as T;
  }

  /** PATCH /<endpoint>/<id>/ with a JSON body. */
  async update<T>(
    endpoint: string,
    id: number | string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.http.patch(`/${endpoint}/${id}/`, cleanParams(body));
    if (response.status >= 400) {
      throw axiosLikeError(response);
    }
    return response.data as T;
  }

  /** DELETE /<endpoint>/<id>/ */
  async del(endpoint: string, id: number | string): Promise<void> {
    const response = await this.http.delete(`/${endpoint}/${id}/`);
    if (response.status >= 400) {
      throw axiosLikeError(response);
    }
  }

  /** GET /<path>/ with raw query params. Used for global search. */
  async raw<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await this.http.get(path.startsWith("/") ? path : `/${path}`, {
      params: cleanParams(params),
    });
    if (response.status >= 400) {
      throw axiosLikeError(response);
    }
    return response.data as T;
  }
}

/**
 * Drop undefined / null / "" params. Arrays are preserved and serialised by
 * `repeatParams` below.
 */
/**
 * Serialise params the way NetBox's filters expect: a repeated key per value,
 * never an indexed or bracketed form.
 */
export function repeatParams(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = paramValue(item);
        if (text !== undefined) search.append(key, text);
      }
    } else {
      const text = paramValue(value);
      if (text !== undefined) search.append(key, text);
    }
  }
  return search.toString();
}

/**
 * A query parameter is a scalar. Anything else — an object, a nested array, a
 * symbol — has no meaningful query-string form, and `String()` would turn it
 * into "[object Object]" and send that to NetBox as a filter value. Drop it
 * instead of transmitting nonsense; the caller's filter names are already
 * validated against the instance's own parameter list upstream of here.
 */
function paramValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return undefined;
}

function cleanParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Shape a 4xx response as an AxiosError-like so `handleApiError` can use the
 * same logic as network errors.
 */
function axiosLikeError(response: { status: number; data: unknown }): Error {
  const err = new axios.AxiosError(
    `Request failed with status code ${response.status}`,
    String(response.status),
  );
  err.response = response as NonNullable<AxiosError["response"]>;
  return err;
}

/** Lazily instantiate the singleton client. */
export function getClient(): NetBoxClient {
  if (!cachedClient) {
    cachedClient = new NetBoxClient(loadConfig());
  }
  return cachedClient;
}

/** Reset the cached client; mainly useful for tests. */
export function resetClient(): void {
  cachedClient = null;
}
