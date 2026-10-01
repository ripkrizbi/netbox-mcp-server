# Live contract suite

Compares what this server **derives** from a NetBox instance's own
`/api/schema/` against what that instance **actually does** when asked. Unit
tests check our code against our own fixture; this checks our fixture's
assumptions against reality. They find different bugs.

**Opt-in and skipped by default.** `npm test` does not run it (see the
`exclude` in `vitest.config.ts`), and without credentials every block is
`describe.skip` with an explanatory banner. It is never a reason for a red
build.

## Running it

```sh
NETBOX_URL=https://netbox.example.com \
NETBOX_TOKEN=<a token with write_enabled = false> \
npm run test:contract
```

The token **must be read-only**. The suite establishes that before any test
file loads and aborts the whole run if the token can write.

| Variable                         | Effect                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `NETBOX_URL`, `NETBOX_TOKEN`     | Required. Absent -> everything skips.                                                |
| `NETBOX_INSECURE=1`              | Accept a self-signed certificate, as the server itself does.                         |
| `NETBOX_CONTRACT_MAX_TYPES=n`    | Cap the endpoint sweep at `n` object types. Default: all of them.                    |
| `NETBOX_CONTRACT_FIELD_SAMPLE=n` | How many object types to compare field-by-field against a real object (24).          |
| `NETBOX_CONTRACT_REFETCH=1`      | Ignore this run's on-disk schema cache and fetch `/api/schema/` again.               |
| `NETBOX_CONTRACT_INCLUDE_HOST=1` | Record the instance hostname in the report. Off by default; the report is committed. |

Expect a few hundred read requests and one 6-13 MB schema fetch. On a large
instance the schema fetch alone takes seconds — NetBox regenerates it per
request (netbox #6423).

## Output

Two forms of the same thing, because assertions alone under-report:

- **Assertions fail loudly.** A defect fails the test that found it, with
  derived-vs-actual in the message.
- **A report is always written**, pass or fail, to
  `docs/reference/spec-defects.md`, and printed to the console between
  `===== NETBOX CONTRACT REPORT BEGIN =====` and `===== NETBOX CONTRACT REPORT END =====`.
  It lists every check, **including the ones that passed** — someone running
  this once should learn what their instance actually does, not only what broke.

Each observation carries a verdict:

| Verdict  | Meaning                                                             |
| -------- | ------------------------------------------------------------------- |
| `OK`     | Reality matched the derived expectation.                            |
| `DEFECT` | Reality contradicted it. A bug here, not in NetBox.                 |
| `INFO`   | Recorded for the operator; there was no expectation to compare.     |
| `N/A`    | Could not be checked here (no objects of that type, no permission). |

## What it checks

| File                               | Subject                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-schema-acquisition.test.ts`    | `/api/schema/?format=json` reachable and parseable; actual Content-Type, byte size, `info.version`; `/api/status/` version and whether it is null.                                          |
| `02-registry-and-envelope.test.ts` | Every derived endpoint answers 200 — a 404 is a derivation bug, and **all** of them are reported. Every list response really is `{count, next, previous, results}`.                         |
| `03-fields-and-enums.test.ts`      | Fields the schema declares that a real object omits, and fields a real object carries that the schema never declares. Every returned enum value against the derived enum, case-sensitively. |
| `04-filters.test.ts`               | A summarised filter really filters; what NetBox does with an **unknown** query parameter (ignore vs 400 — this decides how tolerant `netbox_read` may be); `limit=1000`; `brief=true`.      |
| `05-error-contract.test.ts`        | Real status codes for a bad token, no token, a missing object, a missing endpoint — and the write refusals below.                                                                           |
| `06-plugins.test.ts`               | Which plugins and `/api/plugins/**` paths this instance has, and how plugin object types and write schemas are derived. |

## Why the write probes cannot mutate anything

The suite sends exactly one create and one delete, purely to observe the
refusal. Three independent guards:

1. **`global-setup.ts` proves the token cannot write, before any test file
   loads**, using two side-effect-free probes. `GET /api/users/tokens/` matches
   our own row and reads `write_enabled`; it is the only probe that can prove a
   token is read-only, and it identifies both 4.6 `nbt_<identifier>.<secret>`
   tokens (the API returns the identifier **prefix**) and legacy 40-character
   ones. `OPTIONS` on a collection is **positive evidence only**: DRF's
   `determine_actions` re-runs the POST permission check under a cloned request,
   so `POST` in `actions` proves the token _can_ write — but `actions` is also
   omitted for reasons unrelated to permission, so its absence proves nothing.
   (NetBox 4.6 returns `actions` as an array of method names, not DRF's
   method-keyed object; both shapes are read.) If either probe says the token
   can write, the run **aborts**.
2. **`requireReadOnlyToken()`** throws unless that determination was positive.
   An _indeterminate_ probe skips the write tests rather than guessing.
3. **The requests themselves cannot mutate anything even against a read-write
   token.** The create sends an **empty body** to a collection whose write
   schema has required fields (DRF answers 400 and creates nothing); the delete
   targets an **id that does not exist** (DRF answers 404 and deletes nothing).
   DRF runs `check_permissions` in `initial()`, before both body validation and
   `get_object()`, so a read-only token is refused ahead of either.

Do not change either probe to send a well-formed body or a real id.

## Extending it

Add a file, wrap the block in `describeContract(...)` from `expectations.ts`, and
use `check()` (record + assert, also from `expectations.ts`) or `record()`
(record only, from `harness.ts`) so the observation reaches the report.
`checkAll()` records a batch and then fails once listing every mismatch — use it
whenever "report every one, do not stop at the first" applies.
