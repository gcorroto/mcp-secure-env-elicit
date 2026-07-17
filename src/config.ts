import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { WrapperConfigSchema, type WrapperConfig } from './schemas/wrapper-config.js';

const EnvironmentSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  // Keep the port stable across runs: the browser keys saved form values and
  // passwords on the page origin (scheme + host + port), so a fixed port is
  // what lets it re-propose previously submitted values.
  PORT: z.coerce.number().int().min(0).max(65_535).default(48_910),
  MCP_SECURE_ENV_CONFIG: z.string().min(1).optional(),
  MCP_SECURE_ENV_THEME: z.string().min(1).optional(),
});

export type AppConfig = Readonly<{
  host: string;
  port: number;
  configPath: string;
  /** Theme override from CLI/env; the config file value is the fallback. */
  theme?: string;
}>;

/** Read `--flag value` or `--flag=value` from argv. */
function readArg(argv: readonly string[], flag: string): string | undefined {
  for (const [index, argument] of argv.entries()) {
    if (argument === flag) {
      return argv[index + 1];
    }

    if (argument.startsWith(`${flag}=`)) {
      return argument.slice(flag.length + 1);
    }
  }

  return undefined;
}

const DEFAULT_CONFIG_BASENAME = 'mcp-secure-env.config.json';

function defaultConfigPath(): string | undefined {
  const candidates = [
    resolve(process.cwd(), DEFAULT_CONFIG_BASENAME),
    join(homedir(), '.mcp-secure-env-elicit', 'config.json'),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Load the process configuration. The wrapper config file is located via
 * `--config <path>`, then `MCP_SECURE_ENV_CONFIG`, then
 * `./mcp-secure-env.config.json`, then `~/.mcp-secure-env-elicit/config.json`.
 * The sign-in page theme comes from `--theme`, then `MCP_SECURE_ENV_THEME`,
 * then the `"theme"` field of the config file.
 */
export function loadAppConfig(
  argv: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const parsed = EnvironmentSchema.parse(environment);

  const configPath =
    readArg(argv, '--config') ?? parsed.MCP_SECURE_ENV_CONFIG ?? defaultConfigPath();

  if (configPath === undefined) {
    throw new Error(
      `No configuration found. Pass --config <path>, set MCP_SECURE_ENV_CONFIG, or create ` +
        `'${DEFAULT_CONFIG_BASENAME}' in the working directory (or ` +
        `'~/.mcp-secure-env-elicit/config.json').`,
    );
  }

  const theme = readArg(argv, '--theme') ?? parsed.MCP_SECURE_ENV_THEME;

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    configPath: resolve(configPath),
    ...(theme === undefined ? {} : { theme }),
  };
}

/** Read, parse, and validate the wrapper configuration file. */
export function loadWrapperConfig(filePath: string): WrapperConfig {
  let raw: string;

  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Config file not found or unreadable at '${filePath}': ${reason}`);
  }

  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Config file at '${filePath}' is not valid JSON: ${reason}`);
  }

  const result = WrapperConfigSchema.safeParse(json);

  if (!result.success) {
    throw new Error(
      `Config file at '${filePath}' failed validation: ${z.prettifyError(result.error)}`,
    );
  }

  return result.data;
}
