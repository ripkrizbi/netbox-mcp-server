# Compatibility

What works where, stated honestly. If something below is wrong, that is a bug —
please open an issue.

## Runtime

|           | Supported                                                         |
| --------- | ----------------------------------------------------------------- |
| Node.js   | 20.11 LTS and newer. Node 18 is end-of-life and is not supported. |
| Transport | **stdio only.**                                                   |

### Platforms and architectures

Every row below is exercised on every push. A platform this project has not
run on is not a platform it supports, and the previous version of this table
claimed macOS and Windows while CI ran Linux only.

| OS      | Architecture          | Runner             | Node      |
| ------- | --------------------- | ------------------ | --------- |
| Linux   | x86-64                | `ubuntu-latest`    | 20 and 22 |
| Linux   | ARM64                 | `ubuntu-24.04-arm` | 22        |
| Windows | x86-64                | `windows-latest`   | 22        |
| macOS   | ARM64 (Apple silicon) | `macos-14`         | 22        |
| macOS   | x86-64 (Intel)        | `macos-13`         | 22        |

Each runs typecheck, lint, format, build, the full test suite, and a smoke test
of the built binary's CLI contract — `--version`, `--help`, `--list-tools`
without credentials, and `--check` returning 0 configured and 78 not.

Nothing here is architecture-sensitive by design: the three runtime
dependencies (`@modelcontextprotocol/sdk`, `axios`, `zod`) are pure JavaScript,
so there is no native module to compile and no prebuilt binary to match. ARM
support is a property of Node, not of this package. The matrix exists to prove
that and to catch the things that _are_ platform-specific — path handling,
shell assumptions, and where cache is written.

**Two combinations are untested, and named rather than quietly implied:**

- **Windows ARM64** — GitHub offers no hosted runner for it.
- **macOS x86-64 (Intel)** — a `macos-13` job was added and removed. It sat
  queued with zero steps while every other runner finished; GitHub is retiring
  Intel macOS. A job that never gets scheduled blocks every pull request and
  proves nothing.

Both are expected to work for the same reason the tested rows do — the runtime
dependencies are pure JavaScript, so the platform question is Node's, not this
package's. Expected is not tested, and that is the distinction this table
exists to keep. If you run either, the smoke test is
`node scripts/smoke-cli.mjs` after a build, and a passing report on an untested
row is worth an issue.

### Where the schema cache goes

The server caches the instance's OpenAPI document — several megabytes — keyed
by NetBox version. It is written to the platform's own convention rather than
to `~/.cache` everywhere, because a large file somewhere the OS never looks at
is a file nobody ever cleans up:

|                      | Location                                              |
| -------------------- | ----------------------------------------------------- |
| `XDG_CACHE_HOME` set | `$XDG_CACHE_HOME/netbox-mcp` — wins on every platform |
| Linux                | `~/.cache/netbox-mcp`                                 |
| macOS                | `~/Library/Caches/netbox-mcp`                         |
| Windows              | `%LOCALAPPDATA%\netbox-mcp\Cache`                     |

Deleting the cache directory is safe: the next call re-fetches.

## MCP clients

| Client             | Status            | Notes                                                       |
| ------------------ | ----------------- | ----------------------------------------------------------- |
| Claude Desktop     | Supported         | Launched as a subprocess over stdio.                        |
| Claude Code        | Supported         |                                                             |
| Cursor             | Expected to work  | stdio server, no client-specific behaviour. Untested by us. |
| Codex              | Expected to work  | Untested by us.                                             |
| ChatGPT connectors | **Not supported** | Requires a remote HTTP transport.                           |
| Grok connectors    | **Not supported** | Same reason.                                                |

A remote transport is not planned for `0.1.x`. Until it exists, this server
cannot be used by any client that only speaks HTTP.

## NetBox

|                         |                                                                         |
| ----------------------- | ----------------------------------------------------------------------- |
| Contract-tested against | **NetBox 4.6.0**, with `netbox_inventory` 2.6.0. 435 checks, 0 defects. |
| Known-good range        | 4.6.0 only. See below — one version is not a range.                     |
| Authentication          | API token; legacy tokens use `Authorization: Token <token>`, while NetBox v2 `nbt_...` tokens use `Authorization: Bearer <token>`. |

**Response shapes differ across NetBox versions.** One instance has been tested.
Please include your NetBox version in any bug report.

### Establishing the supported range

The contract suite has run against exactly one live instance: NetBox 4.6.0 with
the `netbox_inventory` plugin. **All 138 derived object types answered 200, and
the run recorded no defects.** The report is committed at
[`docs/reference/spec-defects.md`](./reference/spec-defects.md).

**One instance is evidence, not a range.** Every object type, field, filter and
enum this server offers is derived at runtime from the connected instance's own
`/api/schema/`. That derivation was first written against a committed NetBox
4.6.7 schema document, and the 4.6.0 run then corrected four things the document
had left wrong — an invalid token answering 403 rather than 401, unknown query
parameters being silently ignored rather than rejected, an HTML body on a 404,
and a malformed object-type key. There is no reason to assume a different
version behaves the same.

If you run it and it passes on a version not listed here, that is exactly the
evidence needed to widen this row.

Run it against your instance:

```sh
git clone https://github.com/ZenixSolutions/netbox-mcp-server.git
cd netbox-mcp-server && npm ci
NETBOX_URL=https://netbox.example.com \
NETBOX_TOKEN=<a token with write_enabled = false> \
npm run test:contract
```

- **The token must be read-only.** The suite sends exactly one create and one
  delete, solely to observe how they are refused, and it aborts before running
  anything if it can prove the token is able to write. See
  [`tests/contract/README.md`](../tests/contract/README.md) for the three
  independent guards.
- It is **opt-in**: `npm test` does not run it, and without `NETBOX_URL` /
  `NETBOX_TOKEN` it skips with an explanation instead of failing.
- It makes a few hundred read requests plus one 6-13 MB schema fetch.
- Whatever the outcome, it writes
  [`docs/reference/spec-defects.md`](./reference/spec-defects.md) and prints the
  same content to the console between
  `===== NETBOX CONTRACT REPORT BEGIN =====` and
  `===== NETBOX CONTRACT REPORT END =====`. **Please paste that block into an
  issue**, with or without defects — a clean run on a version not listed here is
  exactly the evidence needed to widen the range, and a failing one is the bug
  report.

The hostname is redacted from the report unless you set
`NETBOX_CONTRACT_INCLUDE_HOST=1`.

### Plugins

`netbox-inventory` (assets, suppliers, purchases, deliveries) has tools
registered for it. They fail with a 404 from NetBox if the plugin is not
installed on your instance.

**`netbox_inventory` 2.6.0 is verified; other plugins are not.** The stock
schema document NetBox generates has no plugins installed, so `/api/plugins/**`
appears nowhere in it and none of the derivation was exercised against a plugin
serializer until a live run. Against 4.6.0 with `netbox_inventory` 2.6.0, all 31
plugin paths classified correctly and all 12 plugin object types resolved their
write schemas — including the two that need the `Writable<Model>Request` form
(`plugins.inventory.assetrole` and `plugins.inventory.inventoryitemgroup`).

That is one plugin. A plugin that names its endpoints differently, or nests them
That is one plugin. A plugin that names its endpoints differently, or nests them
more deeply, has never been tried. The layered search surface now derives its
targets from the connected instance schema, so plugin endpoints are searched
when the instance exposes them.

## Known limitations

- **No remote HTTP transport.** See the client table above.
- **A write costs several calls.** The layered design trades round-trips for
  context. Measured against a live instance: a trivial read is 1 call, and
  creating a device with three prerequisites is 6, five of them before the
  write. See [`docs/reference/eval-results.md`](./reference/eval-results.md).
  In exchange, `tools/list` is ~3,000 tokens rather than the ~180,000 the
  previous one-tool-per-operation surface cost.
- **Models spend more round-trips than the reference path needs.** The eval set
  measures the reference path; three of its ten tasks need a human or an LLM
  judge, and that judgement has since been run and is recorded in
  [`docs/reference/eval-model-in-loop.md`](./reference/eval-model-in-loop.md).
  Two of its three probes went against the design: a name lookup took 10 calls
  against a reference path of 2, and a trivial count took 4 against 1. The cost
  is defensive re-verification through the layers, not missing signposts —
  rewording the tool descriptions in 0.1.3 did not change the counts. The
  impossible-task probe passed: neither model invented a tool.
- **`NETBOX_INSECURE=1` disables TLS verification entirely**, which exposes the
  token to anyone able to intercept the connection. Prefer installing your
  internal root CA into the system trust store.
- **File uploads and NetBox's GraphQL API are not implemented.**
