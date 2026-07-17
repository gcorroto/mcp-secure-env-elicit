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

## Placeholders

`${secure:NAME}` anywhere inside `env` values or `args` strings — including embedded in larger strings (connection URLs, DSNs). The same `NAME` used across several servers is asked **once** and shared.

Optionally pick the form widget: `${secure:NAME:type}` with `text`, `password`, `email`, `number`, `url` or `tel`. Types can also be set in the `secrets` metadata (`"input": "email"`). When nothing is explicit, the widget is inferred from the name: variables matching `PASSWORD`, `PASS`, `PWD`, `SECRET`, `TOKEN`, `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `CREDENTIAL`, `AUTH` render as password inputs; names containing `MAIL` render as email inputs.

## Let the browser remember the values

The form is deliberately **autofill-friendly**: every input has a stable `name`/`id` (the variable name itself) and a real `autocomplete` token — no `autocomplete="off"` anywhere. That means your browser (or password manager) offers to save what you submit and proposes it again the next time the same server asks, so re-entering values after a restart is usually two clicks.

Two things keep autofill working:

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

The sign-in page must be HTTPS (MCP clients only open `https:` URLs for URL elicitation). Out of the box the wrapper uses a self-signed certificate, which the browser flags once. Three ways to make it trusted:

1. **Trust the generated certificate once.** It is persisted at `~/.mcp-secure-env-elicit/tls/cert.pem` (stable across runs, 10-year validity). Import it into your OS trust store and the warning is gone:
   - **Windows:** `certutil -addstore -user Root "%USERPROFILE%\.mcp-secure-env-elicit\tls\cert.pem"`
   - **macOS:** `security add-trusted-cert -k ~/Library/Keychains/login.keychain-db ~/.mcp-secure-env-elicit/tls/cert.pem`
   - **Linux (Debian/Ubuntu):** copy it under `/usr/local/share/ca-certificates/` (as `.crt`) and run `sudo update-ca-certificates`
2. **Use [mkcert](https://github.com/FiloSottile/mkcert).** `mkcert -install && mkcert 127.0.0.1 localhost` mints a locally-trusted pair; point the config at it:
   ```json
   { "tls": { "certPath": "C:/certs/127.0.0.1+1.pem", "keyPath": "C:/certs/127.0.0.1+1-key.pem" } }
   ```
3. **Use your own domain.** Point a real DNS name (e.g. `secure-env.yourdomain.com`) at `127.0.0.1`, get a real certificate for it (Let's Encrypt DNS-01 works fine for loopback names), set `HOST=secure-env.yourdomain.com` and the `tls` paths. Fully green padlock.

## Configuration reference

| Where | What |
|---|---|
| `--config <path>` / `MCP_SECURE_ENV_CONFIG` | Config file location. Defaults: `./mcp-secure-env.config.json`, then `~/.mcp-secure-env-elicit/config.json`. |
| `--theme <name>` / `MCP_SECURE_ENV_THEME` / `"theme"` | Sign-in page theme. |
| `HOST` / `PORT` | Loopback server binding. Defaults `127.0.0.1:48910`. Keep the port stable for browser autofill. |
| `"servers"` | `command`, `args`, `env` (with placeholders), optional `cwd`, optional `autoStart`. Server names cannot contain `_`. |
| `"secrets"` | Optional per-secret `description` and `input`. |
| `"tls"` | Optional `certPath`/`keyPath` for a trusted certificate. |

## Security model, honestly

- Secret values are held AES-256-GCM encrypted in the wrapper's memory, under a key minted per process. They are decrypted only at spawn time, directly into the child's environment.
- Nothing is ever written to disk by the wrapper except TLS material (which contains no secrets).
- Values never enter the MCP conversation: there is deliberately **no** "set secret" tool, so the model cannot be handed a secret even by accident. The only input path is the loopback form.
- The child process receives the secrets as plain environment variables — that is the contract of the servers being wrapped. Anyone able to inspect the child's environment (same OS user) can read them, exactly as if you had configured the server directly.
- Prefer placeholders in `env` over `args`: command lines are visible in process listings.

## Limitations

- Only **tools** are proxied for now (no resources or prompts).
- Wrapped servers must speak **stdio**.

## Development

```bash
npm install
npm run check   # lint + typecheck + tests + build
```

## License

MIT
