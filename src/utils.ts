/**
 * Shared utilities for wiki-gen.
 * Centralises helpers that were previously copy-pasted across multiple modules.
 */

import fs from "node:fs/promises"
import net from "node:net"

/**
 * Parse a "provider/model" string into its component parts.
 * Throws a descriptive error if the format is wrong.
 */
export function parseModel(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const [providerID, ...rest] = model.split("/")
  if (!providerID || rest.length === 0) {
    throw new Error(`Model must be in provider/model format, received: ${model}`)
  }
  return { providerID, modelID: rest.join("/") }
}

/**
 * Returns true if the given path exists and is a regular file.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then((s) => s.isFile()).catch(() => false)
}

/**
 * Cross-platform check for whether a TCP port is already bound on 127.0.0.1.
 * Replaces the Unix-only `lsof -ti :<port>` call.
 */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "EADDRINUSE")
    })
    probe.once("listening", () => {
      probe.close(() => resolve(false))
    })
    probe.listen(port, "127.0.0.1")
  })
}
