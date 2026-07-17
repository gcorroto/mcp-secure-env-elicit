// Minimal child MCP server used by the integration tests. Exposes one `echo`
// tool that returns its argument together with the FIXTURE_SECRET env var, so
// tests can assert that resolved secrets reach the child's environment.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-fixture', version: '0.0.1' });

server.registerTool(
  'echo',
  {
    description: 'Echo the message back together with FIXTURE_SECRET.',
    inputSchema: { message: z.string() },
  },
  ({ message }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({ message, secret: process.env.FIXTURE_SECRET ?? null }),
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
