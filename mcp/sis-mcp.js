#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
if (["rs", "py"].includes(process.env.SIS_IMPL)) {
  const reference = path.join(__dirname, "sis-mcp-reference.js");
  if (!fs.existsSync(reference)) throw Error("Reference MCP is not included in the 1.1 bundle; use the retained reference installation");
  require(reference);
} else {
  if (!process.env.SIS_DB) throw Error("Explicit SIS_DB required for Superiss MCP");
  const root = path.join(__dirname, "../packages/superiss");
  const entry = fs.existsSync(path.join(root, "cli.ts")) ? path.join(root, "cli.ts") : path.join(root, "dist/cli.js");
  const args = [entry, "mcp", "--db", process.env.SIS_DB];
  if (process.env.SIS_SOCK) args.push("--sock", process.env.SIS_SOCK);
  if (process.env.SIS_MCP_PROFILE === "agent") for (const name of ["acquire", "heartbeat", "checkpoint", "resume", "verify", "close_check", "close", "brief", "context", "capabilities", "cancel", "cancel_ack", "tokens"]) args.push("--tool", name);
  const child = spawn(process.env.SIS_BUN || "bun", args, { stdio: "inherit", env: process.env });
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = signal ? 1 : code || 0; });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
}
