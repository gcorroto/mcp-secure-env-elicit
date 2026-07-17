import { z } from 'zod';

/** Secret names follow environment-variable naming so they map 1:1 to env keys. */
export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * HTML input types the sign-in form can render. The type drives both the
 * widget (`<input type=…>`) and the autocomplete hint, so the browser can
 * remember and re-propose previously submitted values.
 */
export const InputTypeSchema = z.enum(['text', 'password', 'email', 'number', 'url', 'tel']);
export type InputType = z.infer<typeof InputTypeSchema>;

const SecretMetaSchema = z
  .object({
    /** Shown under the field on the sign-in form. */
    description: z.string().min(1).optional(),
    /** Explicit input type; overrides name-based detection. */
    input: InputTypeSchema.optional(),
  })
  .strict();

const StdioServerSchema = z
  .object({
    type: z.literal('stdio'),
    command: z.string().min(1).describe('Executable to spawn, e.g. "npx" or "node".'),
    args: z.array(z.string()).default([]),
    env: z.record(z.string().min(1), z.string()).default({}),
    cwd: z.string().min(1).optional(),
    /** Start this server as soon as the wrapper's MCP client connects. */
    autoStart: z.boolean().default(false),
  })
  .strict();

/**
 * A remote URL that may embed `${secure:…}` placeholders anywhere — including
 * the host or port, which the WHATWG parser would reject verbatim. Validate
 * with placeholders masked, and pin the scheme so typos fail at config load
 * instead of as an opaque connect-time fetch error.
 */
const RemoteUrlSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const masked = value.replace(/\$\{secure:[^}]+\}/g, '1');
    let parsed: URL;
    try {
      parsed = new URL(masked);
    } catch {
      ctx.addIssue({ code: 'custom', message: `Invalid URL: '${value}'` });
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        message: `URL must use http(s), got '${parsed.protocol.replace(/:$/, '')}' in '${value}'`,
      });
    }
  });

const RemoteServerSchema = z
  .object({
    /**
     * `http`/`https` try Streamable HTTP first and fall back to SSE; `sse`
     * forces the (legacy) SSE transport.
     */
    type: z.enum(['http', 'https', 'sse']),
    url: RemoteUrlSchema,
    /** HTTP headers sent on every request; values may hold placeholders. */
    headers: z.record(z.string().min(1), z.string()).default({}),
    /**
     * Accept a server certificate that is not publicly trusted (self-signed
     * or internal CA). Applies to this server's requests only.
     */
    insecureTls: z.boolean().default(false),
    /** Start this server as soon as the wrapper's MCP client connects. */
    autoStart: z.boolean().default(false),
  })
  .strict();

// `type` is optional for backwards compatibility, but only for entries that
// look like stdio servers (they have `command`): a remote-shaped entry that
// forgot its `type` should get the union's clear "expected 'stdio' | 'http' |
// 'https' | 'sse'" error, not stdio's "unrecognized key: url".
const ChildServerSchema = z.preprocess(
  (value) =>
    typeof value === 'object' && value !== null && !('type' in value) && 'command' in value
      ? { ...value, type: 'stdio' }
      : value,
  z.discriminatedUnion('type', [StdioServerSchema, RemoteServerSchema]),
);

const TlsConfigSchema = z
  .object({
    /** PEM certificate for the sign-in server (own domain or mkcert). */
    certPath: z.string().min(1),
    /** PEM private key matching `certPath`. */
    keyPath: z.string().min(1),
  })
  .strict();

export const WrapperConfigSchema = z
  .object({
    $schema: z.string().optional(),
    /** Sign-in page theme; see adapters/http/themes.ts for the available names. */
    theme: z.string().optional(),
    /** Bring-your-own TLS so the browser trusts the sign-in page outright. */
    tls: TlsConfigSchema.optional(),
    // No underscores in server names: `__` separates server and tool in the
    // namespaced tool names the wrapper exposes.
    servers: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/), ChildServerSchema),
    /** Optional per-secret metadata (description and input type for the form). */
    secrets: z.record(z.string().regex(SECRET_NAME_PATTERN), SecretMetaSchema).default({}),
  })
  .strict();

export type WrapperConfig = z.infer<typeof WrapperConfigSchema>;
export type ChildServerConfig = z.infer<typeof ChildServerSchema>;
export type StdioServerConfig = z.infer<typeof StdioServerSchema>;
export type RemoteServerConfig = z.infer<typeof RemoteServerSchema>;
export type SecretMeta = z.infer<typeof SecretMetaSchema>;
