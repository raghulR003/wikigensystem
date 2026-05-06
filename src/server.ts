import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { WikiGenConfig } from "./types.js"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"

export interface ServerInstance {
  url: string
  client: OpencodeClient
  close: () => void
}

/**
 * Spawn a local OpenCode server and return a connected client.
 * The server runs the `opencode serve` CLI locally.
 */
export async function startServer(config: WikiGenConfig): Promise<ServerInstance> {
  const { port, hostname } = config

  if (config.verbose) {
    process.stderr.write(`[server] Starting OpenCode server on ${hostname}:${port}...\n`)
  }

  const server = await createOpencodeServer({
    port,
    hostname,
    timeout: 30_000,
    config: { logLevel: config.verbose ? "DEBUG" : "WARN" },
  })

  const client = createOpencodeClient({
    baseUrl: server.url,
    directory: config.target,
  })

  if (config.verbose) {
    process.stderr.write(`[server] OpenCode server ready at ${server.url}\n`)
  }

  return {
    url: server.url,
    client,
    close: server.close,
  }
}
