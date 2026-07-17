# @grec0/mcp-secure-env-elicit

**Stop putting secrets in your `mcp.json`.** This MCP server is a wrapper that launches other MCP servers for you: their config lives inside this package's config file with `${secure:…}` placeholders instead of real values, and when a server needs to start, the missing values are collected from you through a browser form (MCP URL elicitation) and kept **AES-256-GCM encrypted in memory** — never written to disk, never visible to the model or the MCP client.

```
Claude / MCP client ──stdio──▶ mcp-secure-env-elicit ──stdio──▶ your real MCP servers
                                      │                          (spawned with resolved env)
                                      └──▶ https://127.0.0.1:48910/auth   (you type values here)
```

## Why

MCP client configs (`mcp.json`, `claude_desktop_config.json`, …) are plain-text files that end up in dotfile repos, screenshots, and backups. With this wrapper the client config contains **zero secrets**, and the wrapped servers' configs contain **placeholders only**.

## Quick start

**1.** Add the wrapper to your MCP client (e.g. `.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "secure-env": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@grec0/mcp-secure-env-elicit", "--config", "C:/path/to/mcp-secure-env.config.json"]
    }
  }
}
```

**2.** Write the wrapper config (`mcp-secure-env.config.json`) describing the servers to wrap:

```json
{
  "theme": "dark",
  "servers": {
    "oracle": {
      "command": "npx",
      "args": ["-y", "@grec0/mcp-oracle-db"],
      "env": {
        "ORACLE_CONNECTION_STRING": "${secure:ORACLE_USER}/${secure:ORACLE_PASSWORD}@//db.example.com:1521/XEPDB1"
      },
      "autoStart": true
    }
  },
  "secrets": {
    "ORACLE_USER": { "description": "Oracle schema user", "input": "text" },
    "ORACLE_PASSWORD": { "description": "Oracle schema password" }
  }
}
```

**3.** Use it. Ask your client to call `secure_env_start` with `{"server": "oracle"}` (or let `autoStart` do it). If values are missing you get a link like `https://127.0.0.1:48910/auth?token=…` — open it, fill the form, submit, run the command again. Done: the oracle tools now appear as `oracle__<tool>`.

## How the elicitation works

- When a server needs secrets that are not in memory, the wrapper raises a **URL-mode elicitation**. Clients that support it pop a dialog that opens the form; clients that do not (text fallback) receive the URL in the tool result — open it manually and re-run the command after submitting.
- Links are **single-use** and stay valid for the **whole 10-minute window**, even if the tool call already returned.
- Submitted values go straight from the browser form into the encrypted in-memory vault over loopback HTTPS. They never travel through the MCP protocol, so neither the model nor the client ever sees them.
- Values live for the **lifetime of the process**: restart your MCP client and you will be asked again (that is the price of never persisting them).

## Shared config in a git repo

Instead of a local path, `--config` accepts a **git URL** — so one repo (private is fine) holds the team's wrapper config, and every dev just points at it:

```json
"args": ["-y", "@grec0/mcp-secure-env-elicit", "--config", "https://git.example.com/org/mcp-configs.git#teams/backend.json"]
```

- The `#path/inside/repo.json` fragment names the file (or use `--config-file <path>`); without it, `mcp-secure-env.config.json` at the repo root is assumed.
- The repo is cloned shallowly on the **default branch** into `~/.mcp-secure-env-elicit/repos/`. Only the first-ever start pays for the network: afterwards the cached copy is used immediately and refreshed **in the background**, so startup stays well inside MCP client connect timeouts and config changes reach each dev on their *next* restart.
- Tip: MCP clients typically allow ~30s for a server to start, and a cold `npx` download plus the first clone can exceed it. If the very first connection times out, just reconnect — everything is cached by then. Pinning an exact version (`@grec0/mcp-secure-env-elicit@x.y.z`) also makes npx noticeably faster on slow networks.
- Authentication rides on the **system git**: Git Credential Manager on Windows, SSH keys, cached HTTPS credentials — whatever already lets the dev `git clone` that repo works here too. No extra tokens to mint: grant read access to the repo and that is it. (First time ever on a machine, run `git clone <url>` once in a terminal — or let the credential manager's window appear — so the credentials get cached.)
- **Offline-friendly:** if the remote is unreachable but a cached clone exists, the cached copy is used with a warning — being off VPN never blocks startup.
- Remember the config contains **placeholders only**, so read access to the repo reveals no secret values; each dev still provides their own through the local sign-in form.

## Remote servers (HTTP / SSE)

Not every MCP server is a local process. Entries with a `type` of `http`, `https`, or `sse` connect to a **remote** MCP endpoint instead of spawning one, and their `headers` (and even the `url`) accept the same placeholders:

```json
{
  "servers": {
    "sonarqube": {
      "type": "https",
      "url": "https://tools.example.com/sonar-mcp-server/mcp",
      "headers": { "SONARQUBE_TOKEN": "${secure:SONARQUBE_TOKEN}" }
    },
    "db": {
      "type": "sse",
      "url": "https://tools.example.com/mcp-sse-db/sse",
      "headers": { "X-Api-Key": "${secure:DB_API_KEY}" },
      "insecureTls": true
    }
  }
}
```

- `http` / `https` use the modern **Streamable HTTP** transport and automatically fall back to SSE if the endpoint turns out to be a legacy one — so `"type": "https"` works for both kinds without you having to know.
- `sse` forces the legacy SSE transport (headers are sent on the stream request too).
- `insecureTls: true` accepts a server certificate that is not publicly trusted (self-signed or internal CA), scoped to that server's requests only — the equivalent of npm's `strict-ssl=false` for your internal tooling host.
- No `type` (or `"type": "stdio"`) keeps the spawn behaviour: `command`, `args`, `env`, `cwd`.

## Placeholders

`${secure:NAME}` anywhere inside `env` values or `args` strings for stdio servers, and inside `headers` values or the `url` for remote ones — including embedded in larger strings (connection URLs, DSNs, `Bearer …` prefixes). The same `NAME` used across several servers is asked **once** and shared.

Optionally pick the form widget: `${secure:NAME:type}` with `text`, `password`, `email`, `number`, `url` or `tel`. Types can also be set in the `secrets` metadata (`"input": "email"`). When nothing is explicit, the widget is inferred from the name: variables matching `PASSWORD`, `PASS`, `PWD`, `SECRET`, `TOKEN`, `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `CREDENTIAL`, `AUTH` render as password inputs; names containing `MAIL` render as email inputs.

## Let the browser remember the values

The form is deliberately **autofill-friendly**: every input has a stable `name`/`id` (the variable name itself) and a real `autocomplete` token — no `autocomplete="off"` anywhere. That means your browser (or password manager) offers to save what you submit and proposes it again the next time the same server asks, so re-entering values after a restart is usually two clicks.

Three things keep autofill working:

- **A trusted certificate.** Browsers refuse to *save* passwords on pages with certificate errors — if the padlock is broken, Chrome silently skips the "save password?" prompt. Follow the [Trusted TLS](#trusted-tls-no-browser-warning) section once and saving starts working.
- **A stable port.** The browser keys saved values on the page origin (scheme + host + port). The default port is `48910`; if it is busy the wrapper falls back to an ephemeral port for that run (and saved values will not be offered). Override with the `PORT` env var.
- **A stable URL path.** The form always lives at `/auth`; the token travels in the query string, which does not affect autofill.

## Tools

| Tool | Description |
|---|---|
| `secure_env_status` | State of each configured server: `stopped`/`starting`/`running`/`error`, missing secret **names** (never values), pending sign-in URL, tool count. |
| `secure_env_start` | Start a server. Returns the sign-in URL if values are missing; call again after submitting. |
| `secure_env_stop` | Stop a running server and remove its tools. |
| `<server>__<tool>` | Every tool of every running child, forwarded verbatim (schema included). The tool list refreshes via `notifications/tools/list_changed`. |

## Themes

The sign-in page ships with several looks: `light` (default), `dark`, `ocean`, `forest`, `terminal`, `sunset`. Pick one with:

- `--theme dark` on the command line, or
- `MCP_SECURE_ENV_THEME=dark`, or
- `"theme": "dark"` in the config file.

## Trusted TLS (no browser warning)

The sign-in page must be HTTPS (MCP clients only open `https:` URLs for URL elicitation). Out of the box the wrapper generates a **self-signed** certificate — the browser cannot verify who signed it, so it shows "your connection is not private" and, more annoyingly, **refuses to save your passwords** while the certificate is untrusted.

The certificate is persisted at `~/.mcp-secure-env-elicit/tls/cert.pem` — stable across runs, 825-day validity, proper `serverAuth` usage — precisely so you can trust it **once** and be done. Pick one of these, in increasing order of effort:

1. **One command (recommended).** No repo, no paths — the same npx package does it:
   ```
   npx -y @grec0/mcp-secure-env-elicit trust-cert
   ```
   It generates the certificate if needed and registers it in your OS trust store (on Windows, accept the confirmation dialog; on macOS it may ask for your password; on Linux it prints the two `sudo` commands to run). Then restart your browser.

   Why this works: "insecure" only means "signed by someone the OS does not know". Adding the certificate to your user's trusted store makes *you* the authority that vouches for it — reasonable here because the key never leaves your machine and the server only listens on `127.0.0.1`.
2. **Use [mkcert](https://github.com/FiloSottile/mkcert).** `mkcert -install && mkcert 127.0.0.1 localhost` mints a locally-trusted pair; point the config at it:
   ```json
   { "tls": { "certPath": "C:/certs/127.0.0.1+1.pem", "keyPath": "C:/certs/127.0.0.1+1-key.pem" } }
   ```
3. **Use your own domain.** Point a real DNS name (e.g. `secure-env.yourdomain.com`) at `127.0.0.1`, get a real certificate for it (Let's Encrypt DNS-01 works fine for loopback names), set `HOST=secure-env.yourdomain.com` and the `tls` paths. Fully green padlock with zero trust-store changes on any machine.

To verify after trusting: reopen the sign-in page — no warning, and after your first submit the browser offers to save the values.

## Configuration reference

| Where | What |
|---|---|
| `--config <path or git url>` / `MCP_SECURE_ENV_CONFIG` | Config file location — a local path or a `…repo.git[#file]` URL (see *Shared config in a git repo*). Defaults: `./mcp-secure-env.config.json`, then `~/.mcp-secure-env-elicit/config.json`. |
| `--config-file <path>` | File inside the config repo when `--config` is a git URL and has no `#fragment`. |
| `--theme <name>` / `MCP_SECURE_ENV_THEME` / `"theme"` | Sign-in page theme. |
| `HOST` / `PORT` | Loopback server binding. Defaults `127.0.0.1:48910`. Keep the port stable for browser autofill. |
| `"servers"` (stdio) | `command`, `args`, `env` (with placeholders), optional `cwd`, optional `autoStart`. Server names cannot contain `_`. |
| `"servers"` (remote) | `type` (`http`/`https`/`sse`), `url`, `headers` (with placeholders), optional `insecureTls`, optional `autoStart`. |
| `"secrets"` | Optional per-secret `description` and `input`. |
| `"tls"` | Optional `certPath`/`keyPath` for a trusted certificate. |

Note on `autoStart`: servers whose secrets are still missing are **not** prompted at boot — a wrapper hosts many servers and asking for everything on startup would be a wall of prompts. They wait quietly and elicit when first started (`secure_env_start`).

## Security model, honestly

- Secret values are held AES-256-GCM encrypted in the wrapper's memory, under a key minted per process. They are decrypted only at spawn time, directly into the child's environment.
- Nothing is ever written to disk by the wrapper except TLS material (which contains no secrets).
- Values never enter the MCP conversation: there is deliberately **no** "set secret" tool, so the model cannot be handed a secret even by accident. The only input path is the loopback form.
- Error messages are **redacted**: transport and fetch errors can echo the request URL or upstream response bodies, so every secret value (plain and percent-encoded) is scrubbed to `[secret]` before an error reaches stderr, `secure_env_status`, or a tool result. There is a regression test for it.
- The child process receives the secrets as plain environment variables — that is the contract of the servers being wrapped. Anyone able to inspect the child's environment (same OS user) can read them, exactly as if you had configured the server directly.
- Prefer placeholders in `env` over `args`: command lines are visible in process listings.

## Limitations

- Only **tools** are proxied for now (no resources or prompts).

## Development

```bash
npm install
npm run check   # lint + typecheck + tests + build
```

## License

MIT
