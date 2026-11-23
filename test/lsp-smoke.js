#!/usr/bin/env node
// Integration/regression smoke test. Requires a built bin/server.js and Haxe on PATH.
// Uses a real Haxe compiler and LSP messages, not mocked diagnostic responses.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {spawn} = require("node:child_process");
const {performance} = require("node:perf_hooks");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "haxe-lsp-regression-"));
const uri = pathToFileURL(path.join(tmp, "Main.hx")).href;
const valid = "class Main {\n\tstatic function main() {\n\t\tvar value = Math.abs(-1);\n\t}\n}\n";
const invalid = valid.replace("Math.abs(-1)", "MissingType");
fs.writeFileSync(path.join(tmp, "Main.hx"), valid);

const processPath = path.join(__dirname, "..", "bin", "server.js");
const child = spawn(process.execPath, [processPath], {cwd: tmp, stdio: ["pipe", "pipe", "pipe"]});
let input = Buffer.alloc(0), id = 0, stderr = "";
const pending = new Map();
const diagnostics = [];
child.stderr.on("data", chunk => stderr += chunk.toString());
child.on("exit", code => {
  for (const entry of pending.values()) entry.reject(Error("Server exited: " + code + "\n" + stderr));
  pending.clear();
});

function send(message) {
  const json = Buffer.from(JSON.stringify({jsonrpc: "2.0", ...message}));
  child.stdin.write("Content-Length: " + json.length + "\r\n\r\n");
  child.stdin.write(json);
}
function request(method, params, timeout = 20000) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(Error("Timed out waiting for " + method + "\n" + stderr));
    }, timeout);
    pending.set(requestId, {
      resolve: value => {clearTimeout(timer); resolve(value);},
      reject: error => {clearTimeout(timer); reject(error);}
    });
    send({id: requestId, method, params});
  });
}
function receive(message) {
  if (message.method && message.id != null) {
    // Server-initiated registration / progress requests.
    send({id: message.id, result: null});
  } else if (message.method === "textDocument/publishDiagnostics") {
    diagnostics.push({at: performance.now(), params: message.params});
  } else if (message.id != null) {
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      message.error ? entry.reject(Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
  }
}
child.stdout.on("data", chunk => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const end = input.indexOf("\r\n\r\n");
    if (end < 0) return;
    const header = input.subarray(0, end).toString();
    const match = /^Content-Length:\s*(\d+)/im.exec(header);
    assert.ok(match, "LSP response missing Content-Length");
    const length = Number(match[1]);
    if (input.length < end + 4 + length) return;
    const body = input.subarray(end + 4, end + 4 + length).toString();
    input = input.subarray(end + 4 + length);
    receive(JSON.parse(body));
  }
});
function notify(method, params) {send({method, params});}
async function waitDiagnostic(after, condition, timeout = 30000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const found = diagnostics.find(event =>
      event.at >= after && event.params.uri === uri && condition(event.params.diagnostics));
    if (found) return found.at - after;
    await sleep(25);
  }
  throw Error("No matching diagnostics after " + timeout + " ms. Seen: " +
    JSON.stringify(diagnostics.slice(-8).map(d => d.params)) + "\n" + stderr);
}
function completionPosition(text) {
  const before = text.slice(0, text.indexOf("Math.") + "Math.".length);
  const lines = before.split("\n");
  return {line: lines.length - 1, character: lines.at(-1).length};
}
async function main() {
  await request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(tmp).href,
    capabilities: {textDocument: {completion: {}, publishDiagnostics: {}}, workspace: {}},
    initializationOptions: {
      displayArguments: ["-cp", tmp, "-main", "Main", "-js", path.join(tmp, "unused.js")],
      displayServerConfig: {path: "haxe", env: {}, arguments: [], print: {completion: false, reusing: false}, useSocket: true},
      haxelibConfig: {executable: "haxelib"},
      sendMethodResults: false
    }
  });
  notify("initialized", {});
  notify("workspace/didChangeConfiguration", {settings: {haxe: {
    buildCompletionCache: false,
    diagnosticsForAllOpenFiles: true,
    enableDiagnostics: true,
    diagnosticsOnFileOpen: true
  }}});
  notify("textDocument/didOpen", {textDocument: {uri, languageId: "haxe", version: 1, text: valid}});

  // A completed compiler-backed completion proves the Haxe server is ready.
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(350);
    try {
      await request("textDocument/completion", {textDocument: {uri}, position: completionPosition(valid)}, 3000);
      ready = true;
      break;
    } catch (_) {}
  }
  assert.ok(ready, "Haxe server did not become ready");

  // No save: diagnostic must see the editor buffer rather than the valid file on disk.
  const invalidAt = performance.now();
  notify("textDocument/didChange", {
    textDocument: {uri, version: 2},
    contentChanges: [{text: invalid}]
  });
  const invalidLatency = await waitDiagnostic(invalidAt, list =>
    list.some(d => /MissingType|Unknown identifier|Type not found/i.test(d.message)));
  // Again without saving: previous error must be cleared.
  const validAt = performance.now();
  notify("textDocument/didChange", {
    textDocument: {uri, version: 3},
    contentChanges: [{text: valid}]
  });
  const clearLatency = await waitDiagnostic(validAt, list => list.length === 0);

  // Completion latency, measured only after the diagnostic run has settled.
  const completionTimes = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await request("textDocument/completion", {textDocument: {uri}, position: completionPosition(valid)});
    completionTimes.push(Math.round(performance.now() - start));
  }
  const sorted = completionTimes.slice().sort((a, b) => a - b);
  console.log("METRIC unsaved-edit diagnostics: " + Math.round(invalidLatency) + " ms");
  console.log("METRIC diagnostics clear: " + Math.round(clearLatency) + " ms");
  console.log("METRIC completion p50: " + sorted[2] + " ms (samples: " + completionTimes.join(", ") + ")");
  assert.equal(fs.readFileSync(path.join(tmp, "Main.hx"), "utf8"), valid,
    "Test must exercise unsaved edits only");
}
main().then(() => {
  child.kill();
  fs.rmSync(tmp, {recursive: true, force: true});
}).catch(error => {
  console.error(error.stack || error);
  child.kill();
  fs.rmSync(tmp, {recursive: true, force: true});
  process.exitCode = 1;
});
