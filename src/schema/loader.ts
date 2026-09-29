/**
 * Fetches, parses and caches the instance's own OpenAPI document.
 *
 * Four things this module exists to get right:
 *
 *  1. `?format=json` is served as `application/vnd.oai.openapi+json`, NOT
 *     `application/json`. The body is parsed as JSON regardless of the
 *     content-type header — a client that negotiates on content-type sees an
 *     unknown vendor type and hands back binary garbage (§1.2).
 *  2. The document is 6-13 MB. It is parsed in process and NEVER leaves this
 *     layer: no accessor returns it, and no error message quotes it. Only the
 *     compact derivations in `registry.ts` / `describe.ts` reach a caller.
 *  3. Loading is lazy. A session that never calls describe/listObjectTypes
 *     never pays for the fetch — NetBox regenerates the schema on every
 *     request and that takes seconds (netbox #6423).
 *  4. If the schema cannot be fetched, this fails with the reason. There is no
 *     bundled fallback document: serving a stale or foreign schema as though
 *     it were the instance's own is the failure mode the whole layered design
 *     exists to avoid.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

import type { NetBoxConfig } from "../config.js";
import { authorizationHeader } from "../auth.js";
import { isOpenApiDocument, type OpenApiDocument } from "./openapi.js";

const SCHEMA_PATH = "/schema/?format=json";
const STATUS_PATH = "/status/";
const DEFAULT_SCHEMA_TIMEOUT_MS = 180_000;
const DEFAULT_STATUS_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const CACHE_DIR_NAME = "netbox-mcp";
const SNIPPET_CHARS = 120;

export interface HttpResponse {
  status: number;
  statusText: string;
  body: string;
}

/** Injection seam: the tests never touch the network. */
export type HttpGet = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<HttpResponse>;

export interface LoadedSchema {
  document: OpenApiDocument;
  /** NetBox version, from `/api/status/` or the document, else `unknown`. */
  version: string;
  cacheKey: string;
  source: "network" | "disk";
}

export interface SchemaLoaderOptions {
  config: NetBoxConfig;
  httpGet?: HttpGet;
  env?: NodeJS.ProcessEnv;
  /** Overrides the XDG lookup. `null` disables the on-disk cache entirely. */
  cacheDir?: string | null;
  timeoutMs?: number;
  warn?: (message: string) => void;
}

export interface SchemaLoader {
  /** Memoised for the process. Nothing is fetched until this is first called. */
  load(): Promise<LoadedSchema>;
}

/** Thrown when the instance's schema cannot be obtained or understood. */
export class SchemaUnavailableError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Could not load the NetBox OpenAPI schema from ${url}: ${reason} ` +
        `Object-type discovery and field descriptions are unavailable until this is fixed; ` +
        `no substitute schema is used.`,
      options,
    );
    this.name = "SchemaUnavailableError";
  }
}

interface StatusInfo {
  version: string | undefined;
  plugins: string[];
}

function authHeaders(config: NetBoxConfig): Record<string, string> {
  return {
    Authorization: authorizationHeader(config.token),
    Accept: "application/vnd.oai.openapi+json, application/json",
    "Accept-Encoding": "gzip, deflate",
    "User-Agent": "netbox-mcp",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function oneLineSnippet(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
}

function statusReason(status: number, statusText: string): string {
  const label = `HTTP ${status}${statusText ? ` ${statusText}` : ""}.`;
  if (status === 401 || status === 403) {
    return `${label} NETBOX_TOKEN was rejected, or the instance requires authentication for /api/schema/.`;
  }
  if (status === 404) {
    return `${label} This NetBox is too old to expose /api/schema/, or NETBOX_URL points at the wrong path.`;
  }
  if (status >= 500) {
    return `${label} NetBox failed while generating the schema; it is regenerated on every request and can time out on large instances.`;
  }
  return label;
}

/** Default transport: native fetch, with a node:https fallback for NETBOX_INSECURE. */
export function createHttpGet(config: NetBoxConfig): HttpGet {
  return config.insecure ? insecureHttpGet : fetchHttpGet;
}

/** `HttpGet`-compatible: the redirect counter is internal and always defaulted. */
const insecureHttpGet: HttpGet = (url, headers, timeoutMs) =>
  insecureGet(url, headers, timeoutMs, MAX_REDIRECTS);

const fetchHttpGet: HttpGet = async (url, headers, timeoutMs) => {
  const response = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Deliberately no content-type check: drf-spectacular serves
  // `application/vnd.oai.openapi+json`.
  const body = await response.text();
  return { status: response.status, statusText: response.statusText, body };
};

/**
 * TLS-permissive transport for NETBOX_INSECURE=1. Native fetch has no
 * per-request way to relax certificate verification on Node 20/22 without a
 * global override, and a global override is not acceptable.
 */
function insecureGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  redirectsLeft: number,
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const target = new URL(url);
    const requestHeaders = { ...headers };
    const onResponse = (response: http.IncomingMessage): void => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location !== undefined && redirectsLeft > 0) {
        response.resume();
        insecureGet(
          new URL(location, target).toString(),
          headers,
          timeoutMs,
          redirectsLeft - 1,
        ).then(resolve, reject);
        return;
      }
      const encoding = (response.headers["content-encoding"] ?? "").toLowerCase();
      let stream: NodeJS.ReadableStream = response;
      if (encoding.includes("gzip")) stream = response.pipe(zlib.createGunzip());
      else if (encoding.includes("deflate")) stream = response.pipe(zlib.createInflate());
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer | string) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      stream.on("end", () => {
        resolve({
          status,
          statusText: response.statusMessage ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      stream.on("error", reject);
    };

    const request =
      target.protocol === "http:"
        ? http.request(target, { method: "GET", headers: requestHeaders }, onResponse)
        : https.request(
            target,
            { method: "GET", headers: requestHeaders, rejectUnauthorized: false },
            onResponse,
          );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`timed out after ${timeoutMs} ms`));
    });
    request.on("error", reject);
    request.end();
  });
}

export function defaultCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  // XDG wins everywhere when set, including on Windows and macOS: someone who
  // has set it has said where they want cache to go.
  const xdg = env["XDG_CACHE_HOME"]?.trim();
  if (xdg) return join(xdg, CACHE_DIR_NAME);

  // Otherwise use each platform's own convention. `~/.cache` works on Windows
  // and macOS but is not where either puts cache, and a multi-megabyte schema
  // document in an unexpected place is the kind of thing that never gets
  // cleaned up.
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"]?.trim();
    if (localAppData) return join(localAppData, CACHE_DIR_NAME, "Cache");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Caches", CACHE_DIR_NAME);
  }
  return join(homedir(), ".cache", CACHE_DIR_NAME);
}

interface CacheFile {
  cacheKey: string;
  netboxVersion: string;
  fetchedAt: string;
  document: OpenApiDocument;
}

export function createSchemaLoader(options: SchemaLoaderOptions): SchemaLoader {
  const { config } = options;
  const env = options.env ?? process.env;
  const httpGet = options.httpGet ?? createHttpGet(config);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCHEMA_TIMEOUT_MS;
  const warn =
    options.warn ?? ((message: string) => console.error(`[netbox-mcp] ${message}`));
  const cacheDir =
    options.cacheDir === null ? null : (options.cacheDir ?? defaultCacheDir(env));
  const schemaUrl = `${config.apiUrl}${SCHEMA_PATH}`;
  const instanceTag = sha256(config.baseUrl).slice(0, 12);

  let pending: Promise<LoadedSchema> | undefined;

  const cachePath = (cacheKey: string): string | undefined =>
    cacheDir === null
      ? undefined
      : join(cacheDir, `schema-${instanceTag}-${cacheKey}.json`);

  async function readStatus(): Promise<StatusInfo> {
    const url = `${config.apiUrl}${STATUS_PATH}`;
    try {
      const response = await httpGet(url, authHeaders(config), DEFAULT_STATUS_TIMEOUT_MS);
      if (response.status >= 400) {
        warn(`/api/status/ returned HTTP ${response.status}; caching by document hash.`);
        return { version: undefined, plugins: [] };
      }
      const parsed = JSON.parse(response.body) as unknown;
      if (typeof parsed !== "object" || parsed === null)
        return { version: undefined, plugins: [] };
      const record = parsed as Record<string, unknown>;
      // netbox-docker #1582: this is null on some images. Treat it as absent.
      const rawVersion = record["netbox-version"];
      const version =
        typeof rawVersion === "string" && rawVersion.length > 0 ? rawVersion : undefined;
      const rawPlugins = record["plugins"];
      const plugins =
        typeof rawPlugins === "object" && rawPlugins !== null
          ? Object.entries(rawPlugins as Record<string, unknown>)
              .map(([name, value]) => `${name}@${String(value)}`)
              .sort()
          : [];
      return { version, plugins };
    } catch (error) {
      warn(
        `/api/status/ was unreadable (${describeError(error)}); caching by document hash.`,
      );
      return { version: undefined, plugins: [] };
    }
  }

  async function readCache(cacheKey: string): Promise<LoadedSchema | undefined> {
    const path = cachePath(cacheKey);
    if (!path) return undefined;
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const file = parsed as Partial<CacheFile>;
      if (!isOpenApiDocument(file.document)) return undefined;
      return {
        document: file.document,
        version: file.netboxVersion ?? file.document.info?.version ?? "unknown",
        cacheKey,
        source: "disk",
      };
    } catch {
      // A missing, truncated or unreadable cache file is never fatal.
      return undefined;
    }
  }

  async function writeCache(entry: LoadedSchema): Promise<void> {
    const path = cachePath(entry.cacheKey);
    if (!path || cacheDir === null) return;
    const file: CacheFile = {
      cacheKey: entry.cacheKey,
      netboxVersion: entry.version,
      fetchedAt: new Date().toISOString(),
      document: entry.document,
    };
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(path, JSON.stringify(file), "utf8");
    } catch (error) {
      warn(`could not write the schema cache to ${path}: ${describeError(error)}`);
    }
  }

  async function fetchDocument(status: StatusInfo): Promise<LoadedSchema> {
    let response: HttpResponse;
    try {
      response = await httpGet(schemaUrl, authHeaders(config), timeoutMs);
    } catch (error) {
      throw new SchemaUnavailableError(schemaUrl, `${describeError(error)}.`, {
        cause: error,
      });
    }
    if (response.status >= 400) {
      throw new SchemaUnavailableError(
        schemaUrl,
        statusReason(response.status, response.statusText),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body) as unknown;
    } catch (error) {
      throw new SchemaUnavailableError(
        schemaUrl,
        `the response was not JSON (starts with "${oneLineSnippet(response.body)}").`,
        { cause: error },
      );
    }
    if (!isOpenApiDocument(parsed)) {
      // Never quote the body here — if it parsed, it may be the document.
      throw new SchemaUnavailableError(
        schemaUrl,
        "the response parsed as JSON but has no OpenAPI `paths` object.",
      );
    }

    const cacheKey = status.version
      ? sha256([status.version, ...status.plugins].join("|")).slice(0, 16)
      : sha256(response.body).slice(0, 16);
    return {
      document: parsed,
      version: status.version ?? parsed.info?.version ?? "unknown",
      cacheKey,
      source: "network",
    };
  }

  async function loadOnce(): Promise<LoadedSchema> {
    const status = await readStatus();
    if (status.version) {
      const cacheKey = sha256([status.version, ...status.plugins].join("|")).slice(0, 16);
      const cached = await readCache(cacheKey);
      if (cached) return cached;
    }
    const fetched = await fetchDocument(status);
    // A hash-keyed entry can still hit on the next process start, but only
    // after the document has been fetched — which is the honest trade-off when
    // /api/status/ will not tell us the version (netbox-docker #1582).
    if (!status.version) {
      const cached = await readCache(fetched.cacheKey);
      if (cached) return cached;
    }
    await writeCache(fetched);
    return fetched;
  }

  return {
    load(): Promise<LoadedSchema> {
      if (!pending) {
        pending = loadOnce().catch((error: unknown) => {
          // Do not memoise a failure: a token fix or a restarted NetBox should
          // be picked up without restarting the MCP server.
          pending = undefined;
          throw error;
        });
      }
      return pending;
    },
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND") return "the host could not be resolved (ENOTFOUND)";
    if (code === "ECONNREFUSED") return "the connection was refused (ECONNREFUSED)";
    if (error.name === "TimeoutError" || /timed out/i.test(error.message)) {
      return "the request timed out; NetBox regenerates the schema on every request and can be slow";
    }
    if (code !== undefined && /CERT|SSL/i.test(code)) {
      return `TLS verification failed (${code}); set NETBOX_INSECURE=1 for a self-signed certificate`;
    }
    return error.message;
  }
  return String(error);
}
