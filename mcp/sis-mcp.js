#!/usr/bin/env node
"use strict";
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const registry = JSON.parse(fs.readFileSync(path.join(__dirname, "../ops.json"), "utf8"));
const fullTools = registry.ops.map(op => ({name: "sis_" + op.name, description: op.description, inputSchema: op.inputSchema}));
const agentNames = new Set(["acquire", "heartbeat", "checkpoint", "resume", "verify", "close", "brief", "context", "capabilities", "cancel", "cancel_ack", "tokens"]);
const TOOLS = process.env.SIS_MCP_PROFILE === "agent" ? fullTools.filter(t => agentNames.has(t.name.slice(4))) : fullTools;
const db = path.resolve(process.env.SIS_DB || "sis.db");
const canonicalDb = fs.existsSync(db) ? fs.realpathSync(db) : path.join(fs.realpathSync(path.dirname(db)), path.basename(db));
const SOCK = process.env.SIS_SOCK || "/tmp/sis-" + crypto.createHash("sha256").update(canonicalDb).digest("hex").slice(0, 20) + ".sock";
const MAX_FRAME = 1024 * 1024, MAX_PENDING = 64, MAX_STDOUT = 2 * MAX_FRAME;
let sock = null, inflight = null, rbuf = "", inbuf = "", ended = false, stopped = false, boundProjectId = null;
const queue = [];

function finish() {
  if (ended && !inflight && queue.length === 0 && sock) {
    sock.removeAllListeners(); sock.destroy(); sock = null;
  }
}
function drop(error) {
  if (sock) { sock.removeAllListeners(); sock.destroy(); sock = null; }
  rbuf = "";
  const job = inflight; inflight = null;
  if (job) { clearTimeout(job.timer); job.reject(error); }
  setImmediate(pump); finish();
}
function connect() {
  if (sock) return Promise.resolve(sock);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCK);
    const fail = error => { socket.destroy(); reject(error); };
    socket.once("error", fail);
    socket.setTimeout(5000, () => fail(new Error("Superiss connect timeout")));
    socket.once("connect", () => {
      socket.removeListener("error", fail); socket.setEncoding("utf8"); sock = socket;
      let handshake = true;
      socket.on("error", drop);
      socket.on("close", () => drop(new Error("Superiss socket closed")));
      socket.on("data", chunk => {
        rbuf += chunk.toString("utf8");
        if (Buffer.byteLength(rbuf) > MAX_FRAME) return drop(new Error("Superiss response exceeds 1 MiB"));
        let index;
        while ((index = rbuf.indexOf("\n")) >= 0) {
          const line = rbuf.slice(0, index); rbuf = rbuf.slice(index + 1);
          if (!line.trim()) continue;
          if (handshake) {
            handshake = false;
            try {
              const response = JSON.parse(line);
              const identity = response.data;
              if (response.ok !== true || !identity?.project_id || fs.realpathSync(identity.db_path) !== canonicalDb) {
                throw new Error("Superiss database/socket identity mismatch");
              }
              if (boundProjectId && identity.project_id !== boundProjectId) throw new Error("Superiss project identity changed; explicit reconnection required");
              boundProjectId = identity.project_id;
              socket.setTimeout(0); resolve(socket);
            } catch (error) { reject(error); drop(error); return; }
            continue;
          }
          const job = inflight;
          if (!job) return drop(new Error("Unsolicited Superiss response"));
          inflight = null; clearTimeout(job.timer);
          try { job.resolve(JSON.parse(line)); } catch (error) { job.reject(error); }
          setImmediate(pump); finish();
        }
      });
      socket.write(JSON.stringify({cmd: "context", args: {}}) + "\n");
    });
  });
}
function pump() {
  if (stopped || inflight || queue.length === 0) return;
  const job = queue.shift(); inflight = job;
  connect().then(socket => {
    if (inflight !== job) return;
    const verifySeconds = job.cmd === "verify" || (job.cmd === "attest" && job.args.kind === "run") ? Number(job.args.timeout_secs || 10) : 0;
    const watchSeconds = job.cmd === "watch" ? Number(job.args.wait || 0) : 0;
    const seconds = Math.min(305, Math.max(15, Number.isFinite(verifySeconds) ? verifySeconds + 5 : 15, Number.isFinite(watchSeconds) ? watchSeconds + 5 : 15));
    job.timer = setTimeout(() => drop(new Error("Superiss call timeout; reconcile by idempotency key before retry")), seconds * 1000);
    socket.write(job.frame);
  }).catch(error => {
    if (inflight === job) inflight = null;
    job.reject(error); setImmediate(pump); finish();
  });
}
function call(cmd, args) {
  return new Promise((resolve, reject) => {
    if (stopped) return reject(new Error("Superiss MCP transport stopped"));
    if (queue.length + Number(Boolean(inflight)) >= MAX_PENDING) return reject(new Error("Superiss queue capacity reached"));
    if (cmd === "watch" && args.follow) return reject(new Error("MCP uses bounded watch.wait; streaming follow requires a dedicated socket"));
    const frame = JSON.stringify({cmd, args}) + "\n";
    if (Buffer.byteLength(frame) > MAX_FRAME) return reject(new Error("Superiss request exceeds 1 MiB"));
    queue.push({cmd, args, frame, resolve, reject}); pump();
  });
}
function stop(error) {
  stopped = true; ended = true; process.exitCode = 1; process.stdin.destroy();
  for (const job of queue.splice(0)) job.reject(error);
  drop(error);
}
function send(value) {
  if (stopped) return;
  const frame = JSON.stringify(value) + "\n";
  if (process.stdout.writableLength + Buffer.byteLength(frame) > MAX_STDOUT) {
    process.stderr.write("Superiss MCP stdout backpressure limit exceeded\n");
    stop(new Error("Output consumer is not draining"));
    return;
  }
  process.stdout.write(frame);
}
const result = (id, value) => send({jsonrpc: "2.0", id, result: value});
const error = (id, code, message) => send({jsonrpc: "2.0", id, error: {code, message}});
async function onMessage(message) {
  if (!message || message.jsonrpc !== "2.0" || message.id == null) return;
  const {id, method, params} = message;
  if (method === "initialize") return result(id, {protocolVersion: "2024-11-05", capabilities: {tools: {listChanged: false}}, serverInfo: {name: "superiss", version: registry.version}});
  if (method === "ping") return result(id, {});
  if (method === "tools/list") return result(id, {tools: TOOLS});
  if (method !== "tools/call") return error(id, -32601, "Method not found: " + method);
  const name = params?.name || "";
  const op = TOOLS.find(tool => tool.name === name);
  if (!op) return error(id, -32602, "Unknown tool: " + name);
  const args = params.arguments || {};
  try {
    const response = await call(name.slice(4), args);
    return result(id, {content: [{type: "text", text: JSON.stringify(response)}], isError: response.ok !== true});
  } catch (caught) {
    return result(id, {content: [{type: "text", text: JSON.stringify({ok: false, error: {code: "transport", msg: caught.message}})}], isError: true});
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  inbuf += chunk;
  if (Buffer.byteLength(inbuf) > MAX_FRAME) {
    error(null, -32600, "MCP request exceeds 1 MiB"); process.stdin.destroy(); ended = true; finish(); return;
  }
  let index;
  while ((index = inbuf.indexOf("\n")) >= 0) {
    const line = inbuf.slice(0, index); inbuf = inbuf.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { error(null, -32700, "Parse error"); continue; }
    onMessage(message).catch(caught => error(message.id ?? null, -32603, caught.message));
  }
});
process.stdin.on("end", () => { ended = true; finish(); });
process.stdin.on("error", caught => { process.stderr.write(caught.message + "\n"); ended = true; finish(); });
process.stdout.on("error", caught => { process.stderr.write(caught.message + "\n"); stop(caught); });
