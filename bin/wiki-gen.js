#!/usr/bin/env node
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const distMain = path.join(root, "dist", "index.js")

// Try running the compiled version first. Only fall back for missing dist in
// local development; do not hide real runtime errors from users.
try {
  await import(distMain)
} catch (err) {
  if (err && typeof err === "object" && "code" in err && err.code !== "ERR_MODULE_NOT_FOUND") {
    throw err
  }
  // Fall back to tsx for development
  const srcMain = path.join(root, "src", "index.ts")
  const child = spawn("npx", ["tsx", srcMain, ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: root,
  })
  child.on("exit", (code) => process.exit(code ?? 1))
}
