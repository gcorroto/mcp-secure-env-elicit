import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { generate } from 'selfsigned';

export type TlsCredentials = Readonly<{
  key: string;
  cert: string;
  /** Where the certificate lives on disk, when it does. */
  certPath?: string;
  /** True when this run created a new self-signed certificate. */
  generated: boolean;
}>;

export type TlsOptions = Readonly<{
  host: string;
  /** Certificate/key of your own (e.g. a real domain or one made with mkcert). */
  certPath?: string;
  keyPath?: string;
  /** Directory where the fallback self-signed pair is persisted. */
  stateDir: string;
}>;

interface AltName {
  type: 1 | 2 | 6 | 7;
  value?: string;
  ip?: string;
}

/**
 * Resolve the TLS material for the loopback sign-in server.
 *
 * Priority:
 * 1. `certPath`/`keyPath` from the config — bring your own certificate (a real
 *    domain pointed at 127.0.0.1, or one minted with `mkcert`) and the browser
 *    trusts the page outright.
 * 2. A self-signed pair persisted under `stateDir`. Because it is stable
 *    across runs, trusting it once in the OS certificate store removes the
 *    browser warning permanently — regenerating per run would make that
 *    impossible.
 */
export async function loadOrCreateTls(options: TlsOptions): Promise<TlsCredentials> {
  if (options.certPath !== undefined || options.keyPath !== undefined) {
    if (options.certPath === undefined || options.keyPath === undefined) {
      throw new Error('tls.certPath and tls.keyPath must be provided together');
    }

    return {
      key: readFileSync(options.keyPath, 'utf8'),
      cert: readFileSync(options.certPath, 'utf8'),
      certPath: options.certPath,
      generated: false,
    };
  }

  const keyPath = join(options.stateDir, 'key.pem');
  const certPath = join(options.stateDir, 'cert.pem');

  if (existsSync(keyPath) && existsSync(certPath)) {
    return {
      key: readFileSync(keyPath, 'utf8'),
      cert: readFileSync(certPath, 'utf8'),
      certPath,
      generated: false,
    };
  }

  const pems = await generateSelfSignedCert(options.host);
  mkdirSync(options.stateDir, { recursive: true });
  // The key only protects the loopback sign-in page; keep it owner-readable.
  writeFileSync(keyPath, pems.key, { mode: 0o600 });
  writeFileSync(certPath, pems.cert, { mode: 0o644 });

  return { key: pems.key, cert: pems.cert, certPath, generated: true };
}

/**
 * Generate an in-memory self-signed certificate for the loopback sign-in
 * server. HTTPS is required because MCP clients only open `https:` URLs for
 * URL-mode elicitation.
 */
export async function generateSelfSignedCert(
  host: string,
): Promise<Readonly<{ key: string; cert: string }>> {
  const altNames: AltName[] = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' },
  ];

  // Cover a non-default HOST too, whether it is a literal IPv4 or a hostname.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (host !== '127.0.0.1') {
      altNames.push({ type: 7, ip: host });
    }
  } else if (host !== 'localhost') {
    altNames.push({ type: 2, value: host });
  }

  const pems = await generate([{ name: 'commonName', value: host }], {
    keySize: 2048,
    algorithm: 'sha256',
    // 825 days is the maximum Apple accepts for locally-trusted TLS certs
    // (mkcert uses the same bound); long enough that "trust it once in the OS
    // store" remains a workable way to silence the browser warning.
    notAfterDate: new Date(Date.now() + 825 * 24 * 60 * 60 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      // Browsers require a serverAuth EKU on locally-trusted certificates.
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  return { key: pems.private, cert: pems.cert };
}
