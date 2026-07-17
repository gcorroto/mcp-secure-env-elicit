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

const ChildServerSchema = z
  .object({
    command: z.string().min(1).describe('Executable to spawn, e.g. "npx" or "node".'),
    args: z.array(z.string()).default([]),
    env: z.record(z.string().min(1), z.string()).default({}),
    cwd: z.string().min(1).optional(),
    /** Start this server as soon as the wrapper's MCP client connects. */
    autoStart: z.boolean().default(false),
  })
  .strict();

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
export type SecretMeta = z.infer<typeof SecretMetaSchema>;
