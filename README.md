# netbox-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io/) server that lets an AI
assistant read — and, if its token allows, write — your [NetBox](https://netbox.dev/)
instance: DCIM, IPAM, circuits, virtualization, tenancy, power, and whatever plugins that
instance has installed.

Written in TypeScript on the official `@modelcontextprotocol/sdk`. Runs locally over
stdio as a subprocess of an MCP-aware client (Claude Desktop, Claude Code, Cursor,
Codex).

**Five tools, not several hundred.** The object types, fields, filters and enum values
are not hard-coded — they are derived at runtime from the connected instance's own
`/api/schema/` document, so the surface describes _your_ NetBox, including its plugins
and custom fields. A `tools/list` response is about 12,000 characters of descriptions and
schemas, roughly 3,000 tokens.

> **Installing this?** Paste this into Claude, ChatGPT, or any assistant that can browse
> and run commands:
>
> > Read https://raw.githubusercontent.com/zenixsolutions/netbox-mcp-server/main/AGENTS.md
> > and follow it to install the NetBox MCP server on my Mac.
>
> [`AGENTS.md`](AGENTS.md) is a step-by-step runbook written for an AI assistant to
> execute without guessing. Humans can use the Quick start below instead.

---

## Quick start

There is nothing to clone or build. Your MCP client launches the server with `npx`, which
fetches the published package on first use.

You need:

- **Node.js >= 20.11** (`node --version`). Node 18 is end-of-life and unsupported.
- **A NetBox API token** — see [Creating the token](#creating-the-token) below.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows). Add the `netbox` entry to the
`mcpServers` object you already have; do not replace the file.

```json
{
  "mcpServers": {
    "netbox": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "@zenixsolutions/netbox-mcp"],
      "env": {
        "NETBOX_URL": "https://netbox.yourcompany.com",
        "NETBOX_TOKEN": "your-api-token"
      }
    }
  }
}
```

Use the **absolute** path from `command -v npx` as `command`. Claude Desktop is launched
from Finder and never sources your shell profile, so a bare `"npx"` — like a bare
`"node"` — often fails with `spawn npx ENOENT`. Fully quit Claude Desktop (Cmd-Q) and
reopen it after editing the config.

### Claude Code

```bash
read -rs NETBOX_TOKEN                       # paste the token; nothing is echoed
claude mcp add netbox \
  --env NETBOX_URL="https://netbox.yourcompany.com" \
  --env NETBOX_TOKEN="$NETBOX_TOKEN" \
  -- "$(command -v npx)" -y @zenixsolutions/netbox-mcp
unset NETBOX_TOKEN
```

Do not put the token in `~/.zshrc` or any other shell profile. It belongs in the client
config and nowhere else.

Pin the version — `"@zenixsolutions/netbox-mcp@0.2.0"` — if you do not want the tool
surface to change between restarts. This project is below `1.0.0`, and the
[CHANGELOG](CHANGELOG.md) is where surface changes are recorded. Other clients:
[`AGENTS.md`](AGENTS.md).

Then ask your assistant: _"Using the netbox tools, list the first 5 sites."_

### Creating the token

**NetBox → your user menu → API Tokens → Add a token.**

- Leave **Write enabled** unchecked unless the assistant is meant to change
  infrastructure records. This is the only write control there is (see
  [Write access](#write-access)).
- Set an expiry date.
- Constrain the token's object permissions to what the assistant actually needs.

---

## Installing the skill as well

The quick start above installs the tools. The `netbox-modeling` skill installs the
judgement that drives them — build order, required fields, deprecated models, and a
plan you confirm before anything is written.

[**docs/installing-the-skill.md**](docs/installing-the-skill.md) is the per-surface
page, with exact paths and config blocks for all three places this server runs:

- **Claude** (Desktop, Code, Cowork) — one step for both halves:
  `/plugin marketplace add ZenixSolutions/netbox-mcp-server` then
  `/plugin install netbox-mcp@zenix-solutions`. The plugin carries the server config
  and the skill, and prompts for the URL and token.
- **ChatGPT desktop** (a Codex host) — TOML at `~/.codex/config.toml`, skill in
  `~/.agents/skills/`.
- **Grok Build** (xAI's local agent) — TOML at `~/.grok/config.toml`, skill in
  `~/.grok/skills/`; it also reads the Claude plugin above with no configuration.

That page also covers what updates itself and what does not — briefly: Claude plugins
do, at session start; nothing else does.

---

## The five tools

| Tool                   | What it does                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `netbox_global_search` | Finds a named thing when you do not know its type — a hostname, an IP, a VLAN name, a serial.                                                 |
| `netbox_discover`      | Lists the object types this instance supports, and the operations each one allows.                                                            |
| `netbox_describe`      | Explains one object type: required fields, optional fields with enum values, read-only fields, prerequisites, and the filters `list` accepts. |
| `netbox_read`          | Reads objects — one by id, or a filtered, paginated list. Never modifies anything.                                                            |
| `netbox_write`         | Creates, updates or deletes one object.                                                                                                       |

The intended path for a change is `netbox_discover` → `netbox_describe` → `netbox_write`.
`netbox_global_search` is the shortcut past that: looking one named object up costs a
single call rather than three. A read where you already know the type — `dcim.device`,
`ipam.prefix` — is one call to `netbox_read`.

Object type keys are `<app>.<model>`, singular. Plugin models are
`plugins.<plugin>.<model>` and are not guessable, which is what `netbox_discover` is for.

A few behaviours worth knowing:

- **A wrong object type or filter name is refused locally**, with near-misses or the
  valid filter names listed. NetBox itself answers `200` and the entire unfiltered
  collection for a query parameter it does not recognise, so the server rejects unknown
  filters rather than passing them through.
- **`netbox_write` validates `data` against the instance's schema before sending
  anything.** A rejection returns the same description `netbox_describe` would have.
- **`update` is a partial write.** Only the fields present in `data` change.
- **`delete` requires `confirm` to equal the object's current `display` value.** Read the
  object first, copy `display`, pass it back. NetBox cascades deletes — removing a site
  can remove its racks, devices and prefixes — and it cannot be undone.
- `netbox_read` and `netbox_global_search` return Markdown by default or JSON on request.
  Lists page at 50 by default (max 1000) and report `total`, `has_more` and
  `next_offset`; any response over 25,000 characters is truncated with the offset to
  resume from.

**Layering costs round-trips.** A trivial read that one `netbox_read` call answers has
been observed taking four calls, and a name lookup ten. That is measured, not estimated,
and rewording the tool descriptions did not fix it — see
[`docs/reference/eval-model-in-loop.md`](docs/reference/eval-model-in-loop.md) and
[`docs/reference/eval-results.md`](docs/reference/eval-results.md). What it buys is a
`tools/list` that fits in a context window.

The design rationale is
[RFC-003](docs/rfc/RFC-003-netbox-mcp-layered-tool-surface.md).

---

## Configuration

Three environment variables. There are no others.

| Variable          | Required | Default | Meaning                                                                                                                                         |
| ----------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `NETBOX_URL`      | **yes**  | —       | Base URL of your NetBox, e.g. `https://netbox.corp.com`. **Omit `/api`** — the server appends it. A trailing `/` or `/api` is stripped for you. |
| `NETBOX_TOKEN`    | **yes**  | —       | NetBox API token.                                                                                                                               |
| `NETBOX_INSECURE` | no       | off     | `1`/`true`/`yes`/`y`/`on` skips TLS certificate verification. Prefer installing your internal root CA.                                          |

The instance's OpenAPI document is fetched once and cached on disk under
`$XDG_CACHE_HOME/netbox-mcp` (or `~/.cache/netbox-mcp`), keyed by the NetBox version and
installed plugin set from `/api/status/`. Upgrading NetBox or adding a plugin invalidates
it; a cache that cannot be read or written is never fatal.

### Write access

**Write access is controlled by the NetBox token, not by this server.** There is no
server-side read-only switch, and that is deliberate: an environment variable that hides
the write tool is a suggestion, whereas a token with `write_enabled` unchecked and scoped
object permissions is enforced by NetBox, where no tool argument can reach it.

Issue a read-only token for anyone who does not need to change records. If a write is
refused, NetBox answers `403` and the server's error text names the likely cause —
including the token's `write_enabled` flag.

More on operating this safely, including prompt-injection risk with a write-enabled
token: [SECURITY.md](SECURITY.md).

---

## Command-line surface

The binary is normally launched by a client, but it has four verbs for verifying an
install. Substitute `node dist/index.js` for `netbox-mcp` if you built from a clone.

| Command                   | Does                                                                                         | Exit code                       |
| ------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------- |
| `netbox-mcp --help`       | Prints usage and every environment variable. Reads no configuration.                         | 0                               |
| `netbox-mcp --version`    | Prints the version, e.g. `0.2.0`.                                                            | 0                               |
| `netbox-mcp --check`      | Validates configuration and names the first missing or invalid variable.                     | **0** usable, **78** not usable |
| `netbox-mcp --list-tools` | Prints each tool name to stdout and `N tools registered.` to stderr. Needs no NetBox at all. | 0                               |

`--check` is the verb for diagnosing a configuration problem. `--help` returns before any
configuration is read, so it prints the same output whether your credentials are correct,
wrong, or absent — it can never surface a config error.

```bash
# Is the configuration usable? Names the offending variable and exits 78 if not.
NETBOX_URL=https://netbox.corp.com NETBOX_TOKEN="$NETBOX_TOKEN" netbox-mcp --check
# -> ok: netbox-mcp-server v0.2.0 configured for https://netbox.corp.com

# Does the binary work at all? Needs no credentials and makes no network calls.
netbox-mcp --list-tools
# -> netbox_global_search / netbox_discover / netbox_describe / netbox_read / netbox_write
#    5 tools registered.        (on stderr)

# Do the credentials work against NetBox itself?
curl -sS -H "Authorization: Bearer $NETBOX_TOKEN" \
  "$NETBOX_URL/api/dcim/sites/?limit=1" | head -c 200
```

Keep the token in a shell variable rather than typing it into a command: command lines
land in shell history and are visible in `ps` to every process on the machine.

---

## Compatibility and limitations

The honest source is [`docs/compatibility.md`](docs/compatibility.md). In short:

- Contract-tested against **NetBox 4.6.0 with `netbox_inventory` 2.6.0 — 435 checks, 0
  defects.** That is one instance, which is evidence, not a supported range. Response
  shapes differ across NetBox versions; please include yours in any bug report. The
  compatibility doc explains how to run the suite against your own instance with a
  read-only token, and what to send back.
- **stdio only.** There is no remote HTTP transport, so clients that only speak HTTP
  (ChatGPT connectors, Grok connectors) cannot use this.
- One plugin has been verified. Others have never been tried.
- Known limitations — round-trip cost, the `device_id` argument name, no file uploads, no
  GraphQL — are listed there rather than duplicated here.

---

## Building from a clone

For contributors, and for machines that cannot reach the npm registry:

```bash
git clone https://github.com/zenixsolutions/netbox-mcp-server.git
cd netbox-mcp-server
npm ci
npm run build
node dist/index.js --check     # exits 0 when NETBOX_URL and NETBOX_TOKEN are usable
```

Run `npm ci` in a shell with **no** `NETBOX_TOKEN` exported: it executes the install
scripts of every package in the dependency tree, and each one inherits your environment.

Then use the same client config as above, with `command` set to the absolute path from
`command -v node` and `args` set to the absolute path of `dist/index.js`:

```json
"netbox": {
  "command": "/opt/homebrew/bin/node",
  "args": ["/Users/YOU/netbox-mcp-server/dist/index.js"],
  "env": { "NETBOX_URL": "...", "NETBOX_TOKEN": "..." }
}
```

Tildes (`~`) are not expanded by MCP clients — both paths must be absolute.

---

## Troubleshooting

The most common failure by far: **`spawn npx ENOENT` / `spawn node ENOENT` in a GUI
client.** Claude Desktop is launched from Finder and never sources your `~/.zshrc`, so an
`npx` or `node` installed by nvm/fnm/asdf/Volta/Homebrew is invisible to it. Put the
absolute path from `command -v npx` (or `command -v node`) in the config, not the bare
string `"npx"`.

Second most common: **`Missing required environment variable ...`**. Run `--check` with
the same variables the config sets — it names the variable and exits 78.

Claude Desktop logs each server separately:

```bash
tail -f ~/Library/Logs/Claude/mcp-server-netbox.log
```

Full table of symptoms and fixes: [`AGENTS.md`](AGENTS.md).

---

## Development

```bash
npm run dev           # tsx watch src/index.ts
npm run build         # tsc -> dist/
npm run typecheck     # tsc --noEmit, sources + tests
npm run lint          # eslint
npm run format:check  # prettier --check
npm test              # vitest run
npm run test:contract # opt-in, against a live instance with a read-only token
npm run eval          # opt-in, evals/
```

```
src/
  index.ts            entry point; argv parsing (--help/--version/--check/--list-tools)
  server.ts           server construction and introspection
  config.ts           env parsing / validation
  constants.ts        character limits, page sizes, env var names
  client.ts           axios-based NetBox client
  errors.ts           NetBox API error formatting
  formatting.ts       markdown rendering + pagination payload
  schema/             fetch, cache and interpret the instance's /api/schema/
  schemas/common.ts   shared Zod schemas
  tools/layered/      the five tools: search, discover, describe, read, write
skills/
  netbox-modeling/    agent skill, versioned with the tool contract it names
scripts/
  check-changelog.mjs release guard: CHANGELOG has a section for the current version
```

Each tool's description text lives beside its implementation in
`src/tools/layered/*.ts` — that text is the interface most models actually see, and it is
reviewed as such.

---

## Contributing

Issues and pull requests welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

Security vulnerabilities should be reported privately, not as public issues. See
[SECURITY.md](SECURITY.md).

## Disclaimer

This is an independent, community-maintained project. It is not affiliated with, endorsed
by, or supported by NetBox Labs or the NetBox open-source project. "NetBox" is a
trademark of its respective owner.

Provided as-is under the MIT license. You are responsible for what an AI assistant does
with the credentials you give it — read [SECURITY.md](SECURITY.md) before issuing a
write-enabled token for a production NetBox instance.

## License

MIT — see [LICENSE](LICENSE).
