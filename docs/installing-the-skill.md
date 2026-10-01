# Installing the server and the skill

There are two halves, and they are useful separately but designed together:

- **The MCP server** gives the assistant the five `netbox_*` tools. Without it there
  is nothing to call.
- **The `netbox-modeling` skill** gives it the judgement — build order, required
  fields, deprecated models, the plan-then-write loop. Without it the assistant has
  the tools and guesses at how to use them.

All three surfaces below run the same thing: a local **stdio** server launched with
`npx`. None of them needs an HTTP transport, a hosted endpoint, or an account with us.

| Surface                        | MCP config                                       | Skills directory                       | One step for both?  |
| ------------------------------ | ------------------------------------------------ | -------------------------------------- | ------------------- |
| Claude (Desktop, Code, Cowork) | plugin manifest, or `claude_desktop_config.json` | bundled in the plugin                  | **Yes** — plugin    |
| ChatGPT desktop (Codex)        | `~/.codex/config.toml`                           | `~/.agents/skills/`                    | No                  |
| Grok Build                     | `~/.grok/config.toml`                            | `~/.grok/skills/` or `./.grok/skills/` | Yes, via the plugin |

**Grok Bot is not on this list on purpose.** xAI's cloud desktop GUI app (the one that
authenticates with a Cursor account) runs its agent on a cloud VM, so it cannot reach a
stdio server on your machine at all. That is a different product from Grok Build, the
locally installed CLI agent covered below. If you are in Grok Bot, nothing in this
document will work; use Grok Build.

## Before you start

- **Node.js >= 20.11** — `node --version`. Node 18 is end-of-life and unsupported.
- **A NetBox API token** — NetBox → your user menu → API Tokens → Add a token. Leave
  **Write enabled** unchecked unless the assistant is meant to change infrastructure
  records; see [Write access](../README.md#write-access).
- **Your NetBox base URL**, e.g. `https://netbox.example.com`. No `/api` suffix.

---

## Claude (Desktop, Code, Cowork)

### Recommended: install the plugin

The plugin carries the MCP server config _and_ the skill, so this is the only route
that does both halves in one step.

```
/plugin marketplace add ZenixSolutions/netbox-mcp-server
/plugin install netbox-mcp@zenix-solutions
```

Claude then prompts for the two values the server needs:

| Prompt               | Value                        | Stored                                              |
| -------------------- | ---------------------------- | --------------------------------------------------- |
| **NetBox URL**       | `https://netbox.example.com` | `settings.json`                                     |
| **NetBox API token** | your token                   | secure storage — marked `sensitive` in the manifest |

Nothing else is required by hand. You do not edit a config file, and you do not paste
the token into a file that a backup or a screen share can pick up.

### Verify it loaded

1. `/plugin` — `netbox-mcp` is listed and enabled.
2. `/mcp` — a server named `netbox` is connected and shows **5 tools**:
   `netbox_global_search`, `netbox_discover`, `netbox_describe`, `netbox_read`,
   `netbox_write`.
3. Ask: _"Using the netbox tools, list the first 5 sites."_
4. The skill: ask _"rack a new switch in DC1"_ and watch for the assistant proposing a
   plan before writing. That behaviour is the skill; without it you get an immediate
   guess at field names.

If the server shows as failed, run the [`--check` verb](#verify-the-server-anywhere)
in a terminal with the same two values — it names the offending variable.

### If you would rather not use the plugin

Configure the server by hand, exactly as in the [README quick start](../README.md#quick-start):
`claude mcp add …` for Claude Code, or the `mcpServers` entry in
`claude_desktop_config.json` for Claude Desktop. Then install the skill separately:

- **Claude Code** — unpack the skill into `~/.claude/skills/netbox-modeling/` (personal,
  every project) or `.claude/skills/netbox-modeling/` (this project only). The directory
  must contain `SKILL.md` at its top level.
- **Claude Desktop** — upload `dist/skills/netbox-modeling.skill` through the app's
  skills settings.

Build the artifacts from a clone with `npm run build:skill`; it writes both
`dist/skills/netbox-modeling.skill` (the folder, zipped) and
`dist/skills/netbox-modeling.md` (everything flattened into one file, for surfaces that
take a knowledge document rather than a skill).

---

## ChatGPT desktop (Codex)

Since the Codex app merged into ChatGPT desktop, ChatGPT desktop is a Codex host: it
reads Codex's config and Codex's skill directory. The config is **TOML, not JSON** —
pasting a `mcpServers` JSON block here does nothing.

### Route A — the UI

**Settings → MCP servers → Add server → STDIO**, then:

| Field       | Value                                                |
| ----------- | ---------------------------------------------------- |
| Name        | `netbox`                                             |
| Command     | `npx`                                                |
| Arguments   | `-y` and `@zenixsolutions/netbox-mcp@0.2.0`          |
| Environment | `NETBOX_URL` = your URL, `NETBOX_TOKEN` = your token |

### Route B — the config file

| OS      | Path                               |
| ------- | ---------------------------------- |
| macOS   | `~/.codex/config.toml`             |
| Linux   | `~/.codex/config.toml`             |
| Windows | `%USERPROFILE%\.codex\config.toml` |

Append this. Do not replace the file — it holds your other settings.

```toml
[mcp_servers.netbox]
command = "npx"
args = ["-y", "@zenixsolutions/netbox-mcp@0.2.0"]
# The first launch downloads the package; the default 10s is not enough for it.
startup_timeout_sec = 30
# A large NetBox list can outrun the 60s default.
tool_timeout_sec = 120

[mcp_servers.netbox.env]
NETBOX_URL = "https://netbox.example.com"
NETBOX_TOKEN = "paste-your-token-here"
```

Three things that bite here:

- **Use the global file.** A project-scoped `.codex/config.toml` is known not to load
  reliably. Put the server in `~/.codex/config.toml` and it works everywhere.
- **Windows.** `npx` is `npx.cmd`. If the server fails to spawn, run `where npx` and use
  that absolute path as `command`, with backslashes escaped or the string written as a
  TOML literal: `command = 'C:\Program Files\nodejs\npx.cmd'`.
- **The token is now in a plain file.** Restrict it: `chmod 600 ~/.codex/config.toml`.

### Approvals — your annotations do the gating

If you run with `default_tools_approval_mode = "writes"`, Codex prompts for any tool not
marked read-only. That maps onto this server exactly:

| Tool                                                                        | `readOnlyHint`                        | Prompts under `"writes"` |
| --------------------------------------------------------------------------- | ------------------------------------- | ------------------------ |
| `netbox_global_search`, `netbox_discover`, `netbox_describe`, `netbox_read` | `true`                                | no                       |
| `netbox_write`                                                              | `false` (and `destructiveHint: true`) | **yes**                  |

Read and write are separate tools for precisely this reason — so a host that gates on
annotations can let every read through and stop at every write. Nothing else in the
server enforces read-only; the NetBox token's **Write enabled** flag is the real control.

### The skill

Codex reads skills from **`~/.agents/skills/`** — note `.agents`, not `.claude`.

```sh
mkdir -p ~/.agents/skills
unzip dist/skills/netbox-modeling.skill -d ~/.agents/skills/
# -> ~/.agents/skills/netbox-modeling/SKILL.md
```

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.agents\skills" | Out-Null
Expand-Archive -Path .\dist\skills\netbox-modeling.skill `
  -DestinationPath "$env:USERPROFILE\.agents\skills" -Force
```

Symlinked skill folders are supported and followed, so if you keep a clone of this
repository you can point at it instead of copying, and `git pull` becomes the update:

```sh
ln -s "$PWD/skills/netbox-modeling" ~/.agents/skills/netbox-modeling
```

### Verify it loaded

1. Restart ChatGPT desktop.
2. **Settings → MCP servers** shows `netbox` as connected with 5 tools.
3. Ask: _"Using the netbox tools, list the first 5 sites."_
4. Skill: `ls ~/.agents/skills/netbox-modeling/SKILL.md` exists, and the assistant plans
   before writing.

---

## Grok Build

Grok Build is xAI's **locally installed** agent (`curl -fsSL https://x.ai/cli/install.sh | bash`).
It has two routes, and the first is less work.

### Route A — reuse the Claude plugin

Grok Build reads Claude Code marketplaces, plugins, skills, MCP config and `CLAUDE.md`
with no configuration at all. It also picks up MCP servers from `~/.claude.json`,
`.cursor/mcp.json` and a project `.mcp.json`. So if you already installed the plugin for
Claude on this machine, Grok Build has the server and the skill already — there is
nothing to do. If you have not:

```
/plugin marketplace add ZenixSolutions/netbox-mcp-server
/plugin install netbox-mcp@zenix-solutions
```

### Route B — Grok's own config

| OS      | Path                              |
| ------- | --------------------------------- |
| macOS   | `~/.grok/config.toml`             |
| Linux   | `~/.grok/config.toml`             |
| Windows | `%USERPROFILE%\.grok\config.toml` |

Same TOML shape as Codex:

```toml
[mcp_servers.netbox]
command = "npx"
args = ["-y", "@zenixsolutions/netbox-mcp@0.2.0"]
startup_timeout_sec = 30
tool_timeout_sec = 120

[mcp_servers.netbox.env]
NETBOX_URL = "https://netbox.example.com"
NETBOX_TOKEN = "paste-your-token-here"
```

`chmod 600 ~/.grok/config.toml` — the token is in it.

The skill goes in `~/.grok/skills/` (every project) or `./.grok/skills/` (this project):

```sh
mkdir -p ~/.grok/skills
unzip dist/skills/netbox-modeling.skill -d ~/.grok/skills/
# -> ~/.grok/skills/netbox-modeling/SKILL.md
```

### Verify it loaded

1. Restart Grok Build.
2. `/mcp` lists `netbox` with 5 tools.
3. Ask: _"Using the netbox tools, list the first 5 sites."_

---

## Verify the server, anywhere

Before blaming the client, check the server outside it. `--check` validates the
configuration and names the first variable that is missing or invalid.

```sh
NETBOX_URL="https://netbox.example.com" NETBOX_TOKEN="$NETBOX_TOKEN" \
  npx -y @zenixsolutions/netbox-mcp --check
echo $?
```

Windows (PowerShell):

```powershell
$env:NETBOX_URL  = "https://netbox.example.com"
$env:NETBOX_TOKEN = "paste-your-token-here"
npx -y @zenixsolutions/netbox-mcp --check
$LASTEXITCODE
```

| Exit code | Means                                                                            |
| --------- | -------------------------------------------------------------------------------- |
| **0**     | the configuration is usable — prints `ok: netbox-mcp-server v… configured for …` |
| **78**    | not usable — the message names the variable                                      |

`--check` does not talk to NetBox; it validates configuration. To prove the credentials
themselves:

```sh
curl -sS -H "Authorization: Bearer $NETBOX_TOKEN" \
  "$NETBOX_URL/api/dcim/sites/?limit=1" | head -c 200
```

And to prove the binary runs at all, with no credentials and no network:

```sh
npx -y @zenixsolutions/netbox-mcp --list-tools
# -> the five tool names on stdout, "5 tools registered." on stderr
```

---

## Keeping it current

Be clear-eyed about what updates itself and what does not.

**Claude plugins update themselves.** Claude Code checks the marketplace roughly ten
minutes after a session starts, with jitter. Two conditions:

- **Third-party marketplaces default to auto-update OFF.** Ours is third-party. Turn it
  on in `/plugin` → **Marketplaces**, or run `/plugin marketplace update` when you feel
  like it.
- **The plugin is pinned to the `version` in its manifest.** Pushing new commits changes
  nothing for an installed user until that string changes. Bumping it is what ships an
  update — see [releasing.md](releasing.md).

**Nothing else updates.** ChatGPT desktop and Grok Build read the skill from disk at
startup; a newer version in this repository does not reach them. Re-download and unpack
the `.skill`, or use the symlink-to-a-clone trick above and `git pull`. The MCP server
itself is a partial exception: `npx` fetches from npm at launch, so unpinning the version
in your config gets you server updates without getting you skill updates — which is
usually worse than pinning, because the skill and the tool surface are versioned
together on purpose.

**Nothing checks weekly, on any surface.** This is worth stating plainly because it is
the thing people assume:

- ChatGPT Scheduled Tasks and Grok Automations can run on a schedule and send you a
  message. They **cannot write back** to stored skills, custom instructions or project
  files.
- So a weekly _"the skill you have is three versions behind"_ **alarm** is achievable. A
  weekly **refresh** is not. An alarm is a reminder to do the update by hand; it is not
  the update.

---

## Related

- [README quick start](../README.md#quick-start) — the plain MCP-server-only install.
- [`AGENTS.md`](../AGENTS.md) — the full runbook, written for an assistant to follow.
- [`skills/README.md`](../skills/README.md) — what the skill contains and how it is built.
- [`docs/compatibility.md`](compatibility.md) — NetBox versions and known limits.
