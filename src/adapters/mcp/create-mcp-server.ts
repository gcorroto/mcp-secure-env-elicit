import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { type ChildServerManager } from '../../application/child-server-manager.js';

export type McpDependencies = Readonly<{
  children: ChildServerManager;
  version: string;
}>;

const START_TOOL = 'secure_env_start';
const STOP_TOOL = 'secure_env_stop';
const STATUS_TOOL = 'secure_env_status';

const SERVER_ARG_SCHEMA = {
  type: 'object' as const,
  properties: {
    server: {
      type: 'string' as const,
      description: 'Name of the configured server, as listed by secure_env_status.',
    },
  },
  required: ['server'],
  additionalProperties: false,
};

function textResult(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function readServerArg(args: Record<string, unknown> | undefined): string {
  const server = args?.server;
  if (typeof server !== 'string' || server === '') {
    throw new Error(`The 'server' argument is required`);
  }

  return server;
}

/**
 * The wrapper's MCP surface: three management tools plus every tool of every
 * running child, namespaced as `<server>__<tool>`. The tool list changes as
 * children start and stop; `notifications/tools/list_changed` keeps the
 * client's view fresh.
 */
// The low-level Server (not McpServer) is deliberate — the advanced use case
// its deprecation notice reserves it for: a proxy must forward the children's
// JSON Schemas verbatim, which the zod-based high-level API cannot express.
// eslint-disable-next-line @typescript-eslint/no-deprecated
export function createMcpServer({ children, version }: McpDependencies): Server {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(
    { name: 'mcp-secure-env-elicit', version },
    {
      capabilities: { tools: { listChanged: true } },
      instructions:
        'Wrapper that starts other MCP servers with secret env values collected from the ' +
        'operator. Call secure_env_status to see the configured servers, secure_env_start to ' +
        'start one (it may return a sign-in URL for the operator to open — after they submit, ' +
        'call it again), and then use the started server tools, which appear as ' +
        '<server>__<tool>.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    const managementTools: Tool[] = [
      {
        name: STATUS_TOOL,
        description:
          'Status of every configured child server: state, missing secret names (never ' +
          'values), pending sign-in URL, and tool count.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: START_TOOL,
        description:
          'Start a configured child server. If secret values are missing, returns a sign-in ' +
          'URL the operator must open; once they submit the form, call this tool again.',
        inputSchema: SERVER_ARG_SCHEMA,
      },
      {
        name: STOP_TOOL,
        description: 'Stop a running child server and remove its proxied tools.',
        inputSchema: SERVER_ARG_SCHEMA,
      },
    ];

    const childTools: Tool[] = children.listTools().map((tool) => ({
      name: tool.name,
      description: `[${tool.serverName}] ${tool.description ?? ''}`.trim(),
      inputSchema: tool.inputSchema as Tool['inputSchema'],
    }));

    return { tools: [...managementTools, ...childTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;

    try {
      if (name === STATUS_TOOL) {
        return textResult({ servers: children.status() });
      }

      if (name === START_TOOL) {
        const result = await children.ensureStarted(readServerArg(args));
        if (!result.ok) {
          return textResult(result.message, true);
        }

        return textResult({
          started: result.serverName,
          alreadyRunning: result.alreadyRunning,
          tools: result.tools,
        });
      }

      if (name === STOP_TOOL) {
        const serverName = readServerArg(args);
        const stopped = await children.stop(serverName);
        return textResult({ server: serverName, stopped });
      }

      // Anything else must be a namespaced child tool.
      return (await children.callTool(name, args)) as CallToolResult;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(message, true);
    }
  });

  return server;
}
