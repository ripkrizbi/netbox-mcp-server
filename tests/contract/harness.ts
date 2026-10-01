/**
 * Shared plumbing for the contract suite.
 *
 * Three responsibilities:
 *
 *  1. **Opt-in.** Without `NETBOX_URL` and `NETBOX_TOKEN` every block is
 *     skipped, loudly but not fatally. `npm test` never runs this suite at
 *     all (see `vitest.contract.config.ts`), so a developer with credentials
 *     in their shell still gets a hermetic `npm test`.
 *  2. **Safety.** `requireReadOnlyToken()` refuses to let a write probe run
 *     unless the global setup positively established that the token cannot
 *     write. The global setup aborts the whole run if it can write.
 *  3. **Recording.** `check()` writes one observation per assertion, pass or
 *     fail, so the report shows what was verified and not only what broke.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { authorizationHeader } from "../../src/auth.js";
import { buildRegistry, type SchemaRegistry } from "../../src/schema/registry.js";
import { isOpenApiDocument, type OpenApiDocument } from "../../src/schema/openapi.js";
import {
  appendObservation,
  type Observation,
  schemaCachePath,
  statePath,
} from "./observations.js";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  type HttpResult,
  parseJson,
  request,
} from "./http.js";

export interface ContractEnv {
  baseUrl: string;
  apiUrl: string;
  token: string;
  insecure: boolean;
}

export const SKIP_MESSAGE =
  "netbox-mcp contract suite SKIPPED: NETBOX_URL and NETBOX_TOKEN are not both set.\n" +
  "  This suite talks to a real NetBox instance and is opt-in by design.\n" +
  "  Run it with:  NETBOX_URL=https://netbox.example.com NETBOX_TOKEN=<read-only token> npm run test:contract\n" +
  "  The token MUST have write_enabled = false. The suite aborts if it does not.";

function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

/** The configured instance, or undefined when the suite is not opted in. */
export function contractEnv(): ContractEnv | undefined {
  const rawUrl = (process.env["NETBOX_URL"] ?? "").trim();
  const token = (process.env["NETBOX_TOKEN"] ?? "").trim();
  if (rawUrl === "" || token === "") return undefined;
  const baseUrl = rawUrl.replace(/\/+$/, "").replace(/\/api$/i, "");
  return {
    baseUrl,
    apiUrl: `${baseUrl}/api`,
    token,
    insecure: truthy(process.env["NETBOX_INSECURE"]),
  };
}

export const CONTRACT_ENABLED = contractEnv() !== undefined;

/** The configured instance. Only call inside an enabled block. */
export function env(): ContractEnv {
  const value = contractEnv();
  if (!value) throw new Error(SKIP_MESSAGE);
  return value;
}

/* ------------------------------------------------------------------------ */
/* Requests                                                                   */
/* ------------------------------------------------------------------------ */

export interface ApiOptions {
  method?: string;
  body?: string;
  timeoutMs?: number;
  /** Omit the Authorization header entirely. */
  anonymous?: boolean;
  /** Send this token instead of the configured one. */
  token?: string;
  accept?: string;
}

/**
 * Request an `/api/...` path. `path` is appended to the API root and must
 * start with `/`.
 */
export function api(path: string, options: ApiOptions = {}): Promise<HttpResult> {
  const configured = env();
  const headers: Record<string, string> = {
    Accept: options.accept ?? "application/json",
  };
  if (options.anonymous !== true) {
    headers["Authorization"] = authorizationHeader(options.token ?? configured.token);
  }
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  return request(`${configured.apiUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    insecure: configured.insecure,
  });
}

/** Run `fn` over `items` with bounded concurrency, preserving order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        const item = items[index];
        if (index >= items.length || item === undefined) return;
        results[index] = await fn(item, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------------ */
/* Recording                                                                  */
/*                                                                            */
/* Nothing in this module may import `vitest`: it is loaded by                 */
/* `global-setup.ts`, which runs outside a worker and cannot reach vitest's    */
/* internal state. The assertion half lives in `expectations.ts`.             */
/* ------------------------------------------------------------------------ */

/** Record an observation without asserting on it. */
export function record(observation: Observation): void {
  appendObservation(env().baseUrl, observation);
}

/* ------------------------------------------------------------------------ */
/* Token capability                                                           */
/* ------------------------------------------------------------------------ */

export interface TokenCapability {
  /** `true` = can write, `false` = provably cannot, `undefined` = unknown. */
  writeEnabled: boolean | undefined;
  /** How it was determined, for the report. */
  source: string;
  detail: string;
}

export interface PreflightState {
  capability: TokenCapability;
  netboxVersion: string | null;
  plugins: Record<string, string>;
  probedAt: string;
  /**
   * Which token the determination was made about — a salted digest, never the
   * token. State is keyed by base URL alone, so without this a determination
   * made for one token could be reused for another.
   */
  tokenFingerprint?: string | undefined;
}

/**
 * A non-reversible, non-guessable stand-in for a token, for the state file.
 *
 * The digest is over the token only; it is never printed, only compared. It
 * exists so a preflight determination cannot be silently reused for a
 * different token against the same instance.
 */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(`netbox-mcp-contract:${token}`).digest("hex");
}

/* -- Identifying our own row in /api/users/tokens/ ------------------------- */

/** NetBox 4.6's token scheme prefix. */
const V2_TOKEN_PREFIX = "nbt_";

/**
 * The identifier segment of a NetBox 4.6 token, or `undefined` for a legacy one.
 *
 * 4.6 issues tokens shaped `nbt_<identifier>.<secret>`, and
 * `GET /api/users/tokens/` returns only the `<identifier>` in `key`. That is a
 * PREFIX of the token, not a suffix: the legacy "last 6 characters" heuristic
 * below cannot see it, which is why this exists.
 *
 * Pre-4.6 tokens are 40 opaque characters with no scheme prefix and no
 * separator, and the API returns the whole thing (subject to
 * `ALLOW_TOKEN_RETRIEVAL`), so they take the legacy path.
 */
export function v2TokenIdentifier(token: string): string | undefined {
  if (!token.startsWith(V2_TOKEN_PREFIX)) return undefined;
  const rest = token.slice(V2_TOKEN_PREFIX.length);
  const separator = rest.indexOf(".");
  // `<= 0` covers both "no separator" and "empty identifier".
  if (separator <= 0) return undefined;
  return rest.slice(0, separator);
}

/**
 * The outcome of looking for the configured token in a token list.
 *
 * `ambiguous` is deliberately distinct from `matched`: more than one candidate
 * row means we do not know which one is us, and guessing could report
 * `write_enabled = false` for a token that can in fact write.
 */
export type TokenRowMatch =
  | { kind: "matched"; row: Record<string, unknown>; how: string }
  | { kind: "ambiguous"; count: number; how: string }
  | { kind: "none"; how: string };

function soleMatch(hits: readonly Record<string, unknown>[], how: string): TokenRowMatch {
  const first = hits[0];
  if (hits.length === 1 && first !== undefined)
    return { kind: "matched", row: first, how };
  if (hits.length > 1) return { kind: "ambiguous", count: hits.length, how };
  return { kind: "none", how };
}

/**
 * Find the row in `/api/users/tokens/` that is the configured token.
 *
 * Strict by construction: every row that could be the token is collected, and
 * only a single candidate counts as an identification. Two rows that both look
 * like us is `ambiguous`, which the caller must treat as indeterminate.
 */
export function matchTokenRow(
  rows: readonly Record<string, unknown>[],
  token: string,
): TokenRowMatch {
  const identifier = v2TokenIdentifier(token);
  if (identifier !== undefined) {
    // A v2 token is identified by its identifier segment, exactly. The legacy
    // suffix heuristic is NOT applied here: the visible portion is a prefix, so
    // a suffix comparison could only ever match by accident.
    const hits = rows.filter((row) => {
      const key = asString(row["key"]);
      return key !== undefined && (key === identifier || key === token);
    });
    return soleMatch(hits, "the nbt_<identifier> segment");
  }

  const exact = rows.filter((row) => asString(row["key"]) === token);
  if (exact.length > 0) return soleMatch(exact, "full key equality");

  // Legacy fallback: some instances return only the tail of a 40-character key.
  const suffix = rows.filter((row) => {
    const key = asString(row["key"]);
    return key !== undefined && key.length >= 6 && token.endsWith(key.slice(-6));
  });
  return soleMatch(suffix, "the legacy 6-character key suffix");
}

/**
 * The write methods an OPTIONS response advertises, or `undefined` when it
 * advertises no `actions` at all.
 *
 * Two shapes occur in the wild and both must be understood:
 *
 *  - DRF `SimpleMetadata`: `actions` is an OBJECT keyed by method, whose values
 *    are per-field metadata — `{"POST": {"name": {...}}}`.
 *  - NetBox 4.6: `actions` is a bare ARRAY of method names — `["POST", "PUT"]`.
 *
 * `asRecord()` returns `undefined` for arrays by design, so reading `actions`
 * with it alone silently discards the 4.6 shape.
 */
export function actionMethods(value: unknown): string[] | undefined {
  const array = asArray(value);
  if (array) {
    const methods: string[] = [];
    for (const entry of array) {
      const method = asString(entry);
      if (method !== undefined) methods.push(method.toUpperCase());
    }
    return methods;
  }
  const record = asRecord(value);
  if (record) return Object.keys(record).map((method) => method.toUpperCase());
  return undefined;
}

/** A description that claims read-only, e.g. "Read Only Temp Token". */
const CLAIMS_READ_ONLY = /\bread[\s._-]*only\b/i;

/**
 * Descriptions of rows that say "read only" while `write_enabled` is true.
 *
 * Worth surfacing even when it is not our token: a human who trusts these
 * descriptions will hand out a writable token believing it is safe.
 */
export function mislabelledReadOnlyTokens(
  rows: readonly Record<string, unknown>[],
): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row["write_enabled"] !== true) continue;
    const description = asString(row["description"]) ?? "";
    if (CLAIMS_READ_ONLY.test(description)) out.push(description);
  }
  return out;
}

function describeNoMatch(rows: readonly Record<string, unknown>[], how: string): string {
  if (rows.length === 0) {
    return "/api/users/tokens/ returned no tokens at all for this user";
  }
  const withKeys = rows.filter((row) => asString(row["key"]) !== undefined).length;
  if (withKeys === 0) {
    return (
      `/api/users/tokens/ returned ${rows.length} token(s), none of which carried a \`key\` ` +
      "field at all — this instance has ALLOW_TOKEN_RETRIEVAL off"
    );
  }
  return (
    `/api/users/tokens/ returned ${rows.length} token(s), ${withKeys} with a \`key\`, none ` +
    `matching this token by ${how} — the configured token most likely belongs to a ` +
    "different user, whose tokens this endpoint does not list"
  );
}

/**
 * Establish whether this token can write, WITHOUT writing anything.
 *
 * Two probes, of very different strength:
 *
 *  1. `GET /api/users/tokens/`, matching our own row and reading
 *     `write_enabled`. This is the ONLY probe that can prove a token is
 *     read-only, and it is authoritative in both directions.
 *  2. `OPTIONS` on a collection. DRF's `determine_actions` re-runs the POST
 *     permission check under a cloned request, so `POST` appearing in
 *     `actions` PROVES the token can write. The converse does NOT hold:
 *     `SimpleMetadata` omits `actions` whenever the view exposes no serializer
 *     or `determine_actions` yields nothing, and NetBox customises the metadata
 *     class, so an absent or POST-less `actions` is no evidence either way.
 *     This probe is therefore used only to say "yes it can write", never "no it
 *     cannot", and it mutates nothing.
 *
 * Either probe reporting write access is enough to abort.
 */
export async function probeTokenCapability(): Promise<TokenCapability> {
  const configured = env();
  const notes: string[] = [];

  const tokens = await api("/users/tokens/?limit=200");
  if (tokens.status === 200) {
    const payload = asRecord(parseJson(tokens.body));
    if (payload === undefined) {
      notes.push("GET /api/users/tokens/ returned 200 but the body is not a JSON object");
    } else {
      const rows: Record<string, unknown>[] = [];
      for (const entry of asArray(payload["results"]) ?? []) {
        const row = asRecord(entry);
        if (row !== undefined) rows.push(row);
      }

      const count = asNumber(payload["count"]);
      if (count !== undefined && count > rows.length) {
        notes.push(
          `/api/users/tokens/ is paginated: ${count} token(s) exist but only ${rows.length} ` +
            "were inspected, so this token may simply be on a later page",
        );
      }

      const mislabelled = mislabelledReadOnlyTokens(rows);
      const warning =
        mislabelled.length === 0
          ? ""
          : `WARNING: ${mislabelled.length} of ${rows.length} token(s) on this instance have ` +
            "write_enabled = true while describing themselves as read-only " +
            `[${mislabelled.map((text) => JSON.stringify(text)).join(", ")}] — token ` +
            "descriptions here do not reflect capability";

      const match = matchTokenRow(rows, configured.token);
      if (match.kind === "matched") {
        const writeEnabled = match.row["write_enabled"];
        if (typeof writeEnabled === "boolean") {
          return {
            writeEnabled,
            source: "GET /api/users/tokens/",
            detail:
              `matched this token by ${match.how}; write_enabled = ${String(writeEnabled)}` +
              (warning === "" ? "" : `; ${warning}`),
          };
        }
        notes.push(
          `/api/users/tokens/ matched this token by ${match.how} but omitted write_enabled`,
        );
      } else if (match.kind === "ambiguous") {
        notes.push(
          `/api/users/tokens/ returned ${match.count} rows that all match this token by ` +
            `${match.how}; refusing to guess which one it is`,
        );
      } else {
        notes.push(describeNoMatch(rows, match.how));
      }
      if (warning !== "") notes.push(warning);
    }
  } else {
    notes.push(`GET /api/users/tokens/ returned HTTP ${tokens.status}`);
  }

  // Positive evidence only — see this function's doc comment. A missing `POST`
  // is recorded as a note and never returned as `writeEnabled: false`.
  const options = await api("/dcim/sites/", { method: "OPTIONS" });
  if (options.status === 200) {
    const payload = asRecord(parseJson(options.body));
    const methods = actionMethods(payload?.["actions"]);
    if (methods === undefined) {
      notes.push(
        "OPTIONS /api/dcim/sites/ advertised no `actions`, which proves nothing either way",
      );
    } else if (methods.includes("POST")) {
      return {
        writeEnabled: true,
        source: "OPTIONS /api/dcim/sites/",
        detail:
          `metadata advertises actions [${methods.join(", ")}], including POST` +
          (notes.length > 0 ? `; ${notes.join("; ")}` : ""),
      };
    } else {
      notes.push(
        `OPTIONS /api/dcim/sites/ advertises actions [${methods.join(", ") || "none"}] with ` +
          "no POST — consistent with a read-only token, but not proof of one",
      );
    }
  } else {
    notes.push(`OPTIONS /api/dcim/sites/ returned HTTP ${options.status}`);
  }

  return {
    writeEnabled: undefined,
    source: "indeterminate",
    detail: notes.join("; "),
  };
}

/**
 * Read the state the global setup wrote, narrowing it rather than casting.
 *
 * Anything unrecognised degrades to `undefined`, which callers treat as "no
 * determination" — the safe direction.
 */
export function readPreflightState(): PreflightState | undefined {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = asRecord(parseJson(readFileSync(statePath(env().baseUrl), "utf8")));
  } catch {
    return undefined;
  }
  if (parsed === undefined) return undefined;

  const capability = asRecord(parsed["capability"]);
  if (capability === undefined) return undefined;
  const writeEnabled = capability["writeEnabled"];
  if (writeEnabled !== true && writeEnabled !== false && writeEnabled !== undefined) {
    return undefined;
  }

  const plugins: Record<string, string> = {};
  for (const [name, value] of Object.entries(asRecord(parsed["plugins"]) ?? {})) {
    plugins[name] = asString(value) ?? String(value);
  }

  return {
    capability: {
      writeEnabled,
      source: asString(capability["source"]) ?? "unknown",
      detail: asString(capability["detail"]) ?? "",
    },
    netboxVersion: asString(parsed["netboxVersion"]) ?? null,
    plugins,
    probedAt: asString(parsed["probedAt"]) ?? "",
    tokenFingerprint: asString(parsed["tokenFingerprint"]),
  };
}

export function writePreflightState(baseUrl: string, state: PreflightState): void {
  writeFileSync(statePath(baseUrl), JSON.stringify(state, null, 2), "utf8");
}

const INDETERMINATE_GUIDANCE = [
  "",
  "Only GET /api/users/tokens/ can prove a token is READ-ONLY. To make that probe work:",
  "  - the configured token must belong to the user it authenticates as — NetBox lists",
  "    only that user's own tokens, so a token created for someone else is invisible;",
  "  - that user needs permission to read /api/users/tokens/;",
  "  - on NetBox 4.6+ the `key` field carries the `nbt_<identifier>` segment and needs no",
  "    extra setting. On older versions the whole 40-character key is only returned when",
  "    the instance sets ALLOW_TOKEN_RETRIEVAL = True;",
  "  - if several rows matched, exactly one must be identifiable — the guard will not",
  "    guess between candidates.",
  "",
  "OPTIONS metadata cannot close this gap: `actions.POST` proves a token CAN write, but",
  "its absence is not proof that it cannot.",
].join("\n");

/**
 * Refuse to proceed unless the token was PROVEN unable to write.
 *
 * Returns a reason string when the probe is available and negative; throws
 * otherwise. Callers use the return value in the report.
 */
export function requireReadOnlyToken(): string {
  const state = readPreflightState();
  if (!state) {
    throw new Error(
      "No preflight state: the write-refusal probes will not run without a positive " +
        "read-only determination. Run the suite through `npm run test:contract` so the " +
        "global setup executes.",
    );
  }
  if (
    state.tokenFingerprint !== undefined &&
    state.tokenFingerprint !== tokenFingerprint(env().token)
  ) {
    throw new Error(
      "The preflight state on disk was recorded for a DIFFERENT token against this same " +
        "instance. It says nothing about the token now configured. Re-run the suite through " +
        "`npm run test:contract` so the global setup re-probes.",
    );
  }
  if (state.capability.writeEnabled === true) {
    throw new Error(
      "This token can WRITE. No write probe may run. (The global setup should already " +
        "have aborted the run.)",
    );
  }
  if (state.capability.writeEnabled === undefined) {
    throw new Error(
      `Token write capability is indeterminate: ${state.capability.detail}. ` +
        `Refusing to send any write request.\n${INDETERMINATE_GUIDANCE}`,
    );
  }
  return `${state.capability.source}: ${state.capability.detail}`;
}

/* ------------------------------------------------------------------------ */
/* Schema document + derived registry                                         */
/* ------------------------------------------------------------------------ */

/** What the report needs to know about the schema fetch, minus the 13 MB body. */
export interface SchemaFacts {
  status: number;
  statusText: string;
  contentType: string;
  contentEncoding: string;
  /** Bytes on the wire, before decompression. */
  wireBytes: number;
  /** Bytes of JSON. */
  bytes: number;
  elapsedMs: number;
}

export interface FetchedSchema {
  document: OpenApiDocument;
  facts: SchemaFacts;
  fromCache: boolean;
}

function factsOf(result: HttpResult): SchemaFacts {
  return {
    status: result.status,
    statusText: result.statusText,
    contentType: result.contentType,
    contentEncoding: result.contentEncoding,
    wireBytes: result.wireBytes,
    bytes: result.bytes,
    elapsedMs: result.elapsedMs,
  };
}

/** Rebuild the cached facts without casting: a stale cache degrades, never throws. */
function factsFrom(value: unknown): SchemaFacts | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const status = asNumber(raw["status"]);
  const bytes = asNumber(raw["bytes"]);
  if (status === undefined || bytes === undefined) return undefined;
  return {
    status,
    statusText: asString(raw["statusText"]) ?? "",
    contentType: asString(raw["contentType"]) ?? "",
    contentEncoding: asString(raw["contentEncoding"]) ?? "",
    wireBytes: asNumber(raw["wireBytes"]) ?? bytes,
    bytes,
    elapsedMs: asNumber(raw["elapsedMs"]) ?? 0,
  };
}

let cachedSchema: FetchedSchema | undefined;
let cachedRegistry: SchemaRegistry | undefined;

/**
 * Fetch `/api/schema/?format=json` once per run.
 *
 * The document is 6-13 MB and NetBox regenerates it on every request
 * (netbox #6423), so it is cached on disk for the run and reused by every
 * test file. `NETBOX_CONTRACT_REFETCH=1` forces a fresh fetch.
 */
export async function fetchSchema(): Promise<FetchedSchema> {
  if (cachedSchema) return cachedSchema;
  const configured = env();
  const cachePath = schemaCachePath(configured.baseUrl);

  if (!truthy(process.env["NETBOX_CONTRACT_REFETCH"])) {
    try {
      const raw = readFileSync(cachePath, "utf8");
      const parsed = asRecord(JSON.parse(raw) as unknown);
      const document = parsed?.["document"];
      const facts = factsFrom(parsed?.["facts"]);
      if (isOpenApiDocument(document) && facts !== undefined) {
        cachedSchema = { document, facts, fromCache: true };
        return cachedSchema;
      }
    } catch {
      // No usable cache. Fetch.
    }
  }

  const result = await api("/schema/?format=json", {
    accept: "application/vnd.oai.openapi+json, application/json",
    timeoutMs: 300_000,
  });
  if (result.status !== 200) {
    throw new Error(
      `GET /api/schema/?format=json returned HTTP ${result.status} ${result.statusText}. ` +
        "Nothing in this suite can run without the instance's own schema.",
    );
  }
  const parsed: unknown = JSON.parse(result.body);
  if (!isOpenApiDocument(parsed)) {
    throw new Error(
      "GET /api/schema/?format=json parsed as JSON but has no OpenAPI `paths` object.",
    );
  }
  // Store the metadata without the body: the report needs the byte counts and
  // the content-type, not another copy of 13 MB.
  const facts = factsOf(result);
  writeFileSync(cachePath, JSON.stringify({ facts, document: parsed }), "utf8");
  cachedSchema = { document: parsed, facts, fromCache: false };
  return cachedSchema;
}

/** The registry `src/schema/registry.ts` derives from THIS instance. */
export async function derivedRegistry(): Promise<SchemaRegistry> {
  if (cachedRegistry) return cachedRegistry;
  cachedRegistry = buildRegistry((await fetchSchema()).document);
  return cachedRegistry;
}

/** Optional cap on how many object types the endpoint sweep touches. */
export function maxTypes(): number {
  const raw = process.env["NETBOX_CONTRACT_MAX_TYPES"];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
}
