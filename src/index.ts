#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { homedir } from 'node:os';
import { join } from 'node:path';

import { createHttpApp } from './adapters/http/create-http-app.js';
import { resolveTheme } from './adapters/http/themes.js';
import { loadOrCreateTls } from './adapters/http/tls.js';
import { createMcpServer } from './adapters/mcp/create-mcp-server.js';
import { createChildServerManager } from './application/child-server-manager.js';
import { fetchGitConfig } from './application/git-config.js';
import { watchParentProcess, watchStdinEof, type Watcher } from './application/lifecycle.js';
import {
  createSecretRequestService,
  type McpClientBridge,
} from './application/secret-request-service.js';
import { createSecretVault } from './application/secret-vault.js';
import { loadAppConfig, loadWrapperConfig } from './config.js';

/**
 * How long a sign-in may take. A human flow (open browser, accept the
 * self-signed certificate, type the values, submit) easily exceeds the SDK's
 * 60s default request timeout, so both the elicitation request and the token
 * lifetime use this window.
 */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/**
 * Hard deadline for a graceful shutdown. A wedged child, a pending
 * elicitation or a keep-alive socket must never be able to keep the wrapper
 * (and its HTTPS listener) alive after the client is gone.
 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

type WebServer = HttpServer | HttpsServer;

function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function isAddrInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  );
}

/**
 * Bind `server` on `host`, preferring `preferredPort` but falling back to an
 * ephemeral port when it is already in use. Note that an ephemeral port
 * changes the page origin, so the browser will not autofill values saved
 * under the preferred port — hence prefer to keep the configured port free.
 */
function listen(server: WebServer, host: string, preferredPort: number): Promise<number> {
  const bind = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.off('error', onError);
        reject(error);
      };

      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      });
    });

  return bind(preferredPort).catch((error: unknown) => {
    if (isAddrInUse(error) && preferredPort !== 0) {
      process.stderr.write(
        `Port ${String(preferredPort)} is in use — another mcp-secure-env-elicit instance is ` +
          `probably still running. Binding the sign-in server to an ephemeral port instead ` +
          `(saved browser values will not autofill this run).\n`,
      );
      return bind(0);
    }

    throw error;
  });
}

function closeHttpServer(httpServer: WebServer): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // `close()` alone waits for in-flight keep-alive sockets, which a browser
    // left open on the sign-in page happily holds for minutes.
    httpServer.closeAllConnections();
    httpServer.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolvePromise();
    });
  });
}

/**
 * `npx -y @grec0/mcp-secure-env-elicit trust-cert` — generate (if needed) the
 * persisted self-signed certificate and register it in the OS trust store, so
 * the sign-in page loses the browser warning and the browser starts offering
 * to save the submitted values. Devs consume this package via npx only; they
 * should never need to know where the certificate lives.
 */
async function trustCertCommand(): Promise<number> {
  const host = process.env.HOST ?? '127.0.0.1';
  const stateDir = join(homedir(), '.mcp-secure-env-elicit', 'tls');
  const tls = await loadOrCreateTls({ host, stateDir });
  const certPath = tls.certPath ?? join(stateDir, 'cert.pem');
  process.stdout.write(`Sign-in certificate: ${certPath}\n`);

  if (process.platform === 'win32') {
    process.stdout.write('Adding it to your user Trusted Root store (accept the dialog)…\n');
    const result = spawnSync('certutil', ['-addstore', '-user', 'Root', certPath], {
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      process.stdout.write('certutil failed — run this command again and accept the dialog.\n');
      return result.status ?? 1;
    }
  } else if (process.platform === 'darwin') {
    process.stdout.write(
      'Adding it to your login keychain (you may be asked for your password)…\n',
    );
    const keychain = join(homedir(), 'Library', 'Keychains', 'login.keychain-db');
    const result = spawnSync('security', ['add-trusted-cert', '-k', keychain, certPath], {
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      return result.status ?? 1;
    }
  } else {
    process.stdout.write(
      'On Linux, run:\n' +
        `  sudo cp "${certPath}" /usr/local/share/ca-certificates/mcp-secure-env-elicit.crt\n` +
        '  sudo update-ca-certificates\n',
    );
    return 0;
  }

  process.stdout.write(
    'Done. Restart your browser: the sign-in page is now trusted and the browser will offer ' +
      'to remember the values you submit.\n',
  );
  return 0;
}

async function main(): Promise<void> {
  const commandArgs = process.argv.slice(2);
  if (commandArgs[0] === 'trust-cert') {
    process.exitCode = await trustCertCommand();
    return;
  }

  const version = packageVersion();
  const appConfig = loadAppConfig();
  const configPath =
    appConfig.configSource.kind === 'file'
      ? appConfig.configSource.path
      : fetchGitConfig(
          appConfig.configSource.source,
          join(homedir(), '.mcp-secure-env-elicit', 'repos'),
        );
  const wrapperConfig = loadWrapperConfig(configPath);
  const theme = resolveTheme(appConfig.theme ?? wrapperConfig.theme);

  const vault = createSecretVault();

  // Late binding: the secret service needs the MCP server (to elicit and to
  // read the client's capabilities), but the MCP server is built from the
  // child manager, which needs the secret service. The holder's `server` is
  // set below before the transport connects — long before any tool call could
  // trigger elicitation — so the bridge only ever reads it once it is set.
  const mcp: { server?: ReturnType<typeof createMcpServer> } = {};
  const clientBridge: McpClientBridge = {
    supportsUrlElicitation: () => Boolean(mcp.server?.getClientCapabilities()?.elicitation?.url),
    elicitUrl: async ({ message, url }, options) => {
      if (mcp.server === undefined) {
        throw new Error('MCP server is not initialized');
      }

      // Wait for the human sign-in rather than the SDK's 60s default; the
      // signal lets us dismiss the dialog once the values arrive via POST.
      const result = await mcp.server.elicitInput(
        { mode: 'url', message, url, elicitationId: randomUUID() },
        options?.signal !== undefined
          ? { timeout: SIGN_IN_TIMEOUT_MS, signal: options.signal }
          : { timeout: SIGN_IN_TIMEOUT_MS },
      );

      return { action: result.action };
    },
  };

  // Set to the real base URL once the server is listening (the port may fall
  // back to an ephemeral one). The secret service reads it lazily at prompt
  // time, so a provisional value is fine here.
  let signInBaseUrl = `https://${appConfig.host}:${String(appConfig.port)}`;

  const secretRequests = createSecretRequestService({
    // HTTPS: MCP clients only open `https:` URLs for URL-mode elicitation.
    authBaseUrl: () => signInBaseUrl,
    client: clientBridge,
    vault,
    requestTimeoutMs: SIGN_IN_TIMEOUT_MS,
  });

  const children = createChildServerManager({
    config: wrapperConfig,
    vault,
    secretRequests,
    clientVersion: version,
    onToolsChanged: () => {
      void mcp.server?.sendToolListChanged().catch(() => undefined);
    },
  });

  const httpApp = createHttpApp({ auth: secretRequests, theme, serviceVersion: version });
  const server = createMcpServer({ children, version });
  mcp.server = server;

  const tls = await loadOrCreateTls({
    host: appConfig.host,
    stateDir: join(homedir(), '.mcp-secure-env-elicit', 'tls'),
    ...(wrapperConfig.tls === undefined
      ? {}
      : { certPath: wrapperConfig.tls.certPath, keyPath: wrapperConfig.tls.keyPath }),
  });
  if (tls.generated && tls.certPath !== undefined) {
    process.stderr.write(
      `[secure-env] self-signed certificate created at ${tls.certPath}. Trust it once in your ` +
        `OS certificate store to remove the browser warning, or point "tls" in the config at ` +
        `a certificate of your own.\n`,
    );
  }
  const httpServer = createHttpsServer({ key: tls.key, cert: tls.cert }, httpApp);
  const boundPort = await listen(httpServer, appConfig.host, appConfig.port);
  signInBaseUrl = `https://${appConfig.host}:${String(boundPort)}`;

  // Disposed on shutdown so a watcher can never fire mid-teardown.
  const watchers: Watcher[] = [];

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    process.stderr.write(`Shutting down after ${reason}\n`);
    for (const watcher of watchers) {
      watcher.dispose();
    }

    secretRequests.dispose();
    await children.stopAll().catch(() => undefined);
    vault.dispose();
    await Promise.all([
      server.close().catch(() => undefined),
      closeHttpServer(httpServer).catch(() => undefined),
    ]);
  };

  const requestShutdown = (reason: string): void => {
    if (shuttingDown) {
      return;
    }

    // Exiting explicitly is the whole point: the sign-in server (and a child's
    // pipes) hold the event loop open, so returning from shutdown() would not
    // end the process — the wrapper would linger for ever once its client is
    // gone. The unref'd timer is the escape hatch for a teardown that hangs.
    const hardExit = setTimeout(() => {
      process.stderr.write(
        `Shutdown did not finish in ${String(SHUTDOWN_TIMEOUT_MS)}ms; exiting\n`,
      );
      process.exit(process.exitCode ?? 0);
    }, SHUTDOWN_TIMEOUT_MS);
    hardExit.unref();

    void shutdown(reason)
      .catch((error: unknown) => {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        process.stderr.write(`Shutdown failed: ${message}\n`);
        process.exitCode = 1;
      })
      .finally(() => {
        clearTimeout(hardExit);
        process.exit(process.exitCode ?? 0);
      });
  };

  process.once('SIGINT', () => {
    requestShutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    requestShutdown('SIGTERM');
  });
  server.onclose = () => {
    requestShutdown('MCP transport closed');
  };

  // Last resort, on every exit path (including the hard one above): no stdio
  // child may outlive the wrapper, or the leak just moves one level down.
  process.on('exit', () => {
    children.killRemainingChildren();
  });

  // No MCP client sends SIGINT/SIGTERM on Windows — and with `npx` there is a
  // `cmd.exe` in between anyway — so the parent going away has to be noticed
  // by polling it. See issue #1.
  watchers.push(
    watchParentProcess({
      onParentGone: () => {
        requestShutdown('parent process exited');
      },
    }),
  );

  // Auto-start children once the client is connected — but never demand auth
  // at boot. A wrapper hosts many servers, each with its own values; prompting
  // for all of them on startup would be a wall of dialogs (or log noise).
  // Servers whose secrets are still missing stay stopped and elicit on first
  // use (secure_env_start) instead.
  server.oninitialized = () => {
    const missingByName = new Map(
      children.status().map((child) => [child.name, child.missingSecrets]),
    );

    for (const [name, child] of Object.entries(wrapperConfig.servers)) {
      if (!child.autoStart) {
        continue;
      }

      const missing = missingByName.get(name) ?? [];
      if (missing.length > 0) {
        process.stderr.write(
          `[secure-env] '${name}' waits for ${missing.join(', ')}; it will ask when first started\n`,
        );
        continue;
      }

      void children
        .ensureStarted(name)
        .then((result) => {
          if (!result.ok) {
            process.stderr.write(`[secure-env] autostart '${name}': ${result.message}\n`);
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[secure-env] autostart '${name}' failed: ${message}\n`);
        });
    }
  };

  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (error: unknown) {
    await shutdown('MCP connection failure');
    throw error;
  }

  // `Protocol.connect` owns `transport.onclose`; chain rather than replace it.
  const transportClosed = transport.onclose?.bind(transport);
  transport.onclose = () => {
    transportClosed?.();
    requestShutdown('stdio transport closed');
  };

  // The client hanging up is an EOF on stdin, and nothing in the SDK watches
  // for it: `StdioServerTransport.start()` only subscribes to 'data' and
  // 'error', so `server.onclose` never fires on disconnect. Installed after
  // connect(), whose 'data' listener is what makes 'end' fire at all.
  watchers.push(
    watchStdinEof(process.stdin, () => {
      requestShutdown('stdin closed (client disconnected)');
    }),
  );

  // stdout is reserved for MCP JSON-RPC messages when using stdio.
  process.stderr.write(
    `mcp-secure-env-elicit v${version} — sign-in page (self-signed) on ` +
      `https://${appConfig.host}:${String(boundPort)}/auth\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Failed to start server: ${message}\n`);
  process.exitCode = 1;
  // A half-started wrapper may already hold the sign-in listener open, which
  // would keep the event loop (and the process) alive for ever. The unref'd
  // delay only gives stderr a chance to flush first.
  setTimeout(() => {
    process.exit(1);
  }, 100).unref();
});
