/**
 * Cloudflare Workers entry point for BookStack MCP Server.
 *
 * Exposes a single POST /mcp endpoint that handles JSON-RPC MCP messages
 * and returns JSON responses (stateless HTTP transport).
 *
 * Secrets (set via `wrangler secret put`):
 *   BOOKSTACK_API_TOKEN
 *
 * Vars (set in wrangler.toml or the dashboard):
 *   BOOKSTACK_BASE_URL, SERVER_NAME, SERVER_VERSION, LOG_LEVEL, etc.
 */

import { BookStackMCPServer } from './server';

export interface Env {
  BOOKSTACK_BASE_URL: string;
  BOOKSTACK_API_TOKEN: string;
  BOOKSTACK_TIMEOUT?: string;
  SERVER_NAME?: string;
  SERVER_VERSION?: string;
  RATE_LIMIT_REQUESTS_PER_MINUTE?: string;
  RATE_LIMIT_BURST_LIMIT?: string;
  LOG_LEVEL?: string;
}

// Minimal JSON-RPC message shape
interface JSONRPCMessage {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/**
 * In-memory transport that bridges a single HTTP request to the MCP Server.
 * One instance is created per request — not shared between concurrent requests.
 */
class RequestTransport {
  private responseQueue: JSONRPCMessage[] = [];
  private waiters: Array<(msg: JSONRPCMessage) => void> = [];

  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      this.responseQueue.push(message);
    }
  }

  async close(): Promise<void> {}

  inject(message: JSONRPCMessage): void {
    this.onmessage?.(message as any);
  }

  receive(): Promise<JSONRPCMessage> {
    if (this.responseQueue.length > 0) {
      return Promise.resolve(this.responseQueue.shift()!);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function setProcessEnv(env: Env): void {
  // CF Workers env bindings are not on process.env by default — copy them over.
  process.env.BOOKSTACK_BASE_URL = env.BOOKSTACK_BASE_URL;
  process.env.BOOKSTACK_API_TOKEN = env.BOOKSTACK_API_TOKEN;
  if (env.BOOKSTACK_TIMEOUT) process.env.BOOKSTACK_TIMEOUT = env.BOOKSTACK_TIMEOUT;
  if (env.SERVER_NAME) process.env.SERVER_NAME = env.SERVER_NAME;
  if (env.SERVER_VERSION) process.env.SERVER_VERSION = env.SERVER_VERSION;
  if (env.RATE_LIMIT_REQUESTS_PER_MINUTE) process.env.RATE_LIMIT_REQUESTS_PER_MINUTE = env.RATE_LIMIT_REQUESTS_PER_MINUTE;
  if (env.RATE_LIMIT_BURST_LIMIT) process.env.RATE_LIMIT_BURST_LIMIT = env.RATE_LIMIT_BURST_LIMIT;
  if (env.LOG_LEVEL) process.env.LOG_LEVEL = env.LOG_LEVEL;
  // Note: process.env.NODE_ENV is a compile-time constant in esbuild — do not assign
}

// Cached server instance (reused across requests within the same isolate)
let cachedServer: BookStackMCPServer | null = null;

function getServer(env: Env): BookStackMCPServer {
  if (!cachedServer) {
    setProcessEnv(env);
    cachedServer = new BookStackMCPServer();
  }
  return cachedServer;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' }, { headers: CORS_HEADERS });
    }

    if (url.pathname === '/mcp' && request.method === 'POST') {
      let body: JSONRPCMessage | undefined;

      try {
        body = (await request.json()) as JSONRPCMessage;
      } catch {
        return Response.json(
          { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
          { status: 400, headers: CORS_HEADERS }
        );
      }

      try {
        const server = getServer(env);
        const transport = new RequestTransport();
        await server.connectTransport(transport);

        transport.inject(body!);

        const response = await Promise.race([
          transport.receive(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Request timeout after 30s')), 30000)
          ),
        ]);

        return Response.json(response, { headers: CORS_HEADERS });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal server error';
        return Response.json(
          { jsonrpc: '2.0', error: { code: -32603, message }, id: body?.id ?? null },
          { status: 500, headers: CORS_HEADERS }
        );
      }
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  },
};
