import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SessionStore } from "../dist/src/store.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "spider-live-"));
const workspace = path.join(temporary, "workspace");
const dataDirectory = path.join(temporary, "data");
await mkdir(path.join(workspace, "demo"), { recursive: true });
await copyFile(path.join(root, "workspace/demo/invoice.json"), path.join(workspace, "demo/invoice.json"));
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const baseUrl = `http://127.0.0.1:${port}/v1`;
const environment = {
  ...process.env,
  SPIDER_PROVIDER: "local", SPIDER_MODEL: "spider-local", SPIDER_BASE_URL: baseUrl,
  SPIDER_WORKSPACE: workspace, SPIDER_DATA_DIR: dataDirectory,
  SPIDER_TIMEOUT_MS: "180000", SPIDER_MAX_STEPS: "16", SPIDER_MAX_TOKENS: "1024",
};
const invoke = async (args) => {
  const result = await promisify(execFile)(process.execPath, [path.join(root, "dist/src/cli.js"), ...args, "--json"], {
    env: environment, cwd: root, timeout: 240_000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout);
};
let store;
const report = { ok: false, testedAt: new Date().toISOString() };
try {
  report.runtime = JSON.parse((await readFile(path.join(root, ".runtime/local-model.json"), "utf8")).trim());
  console.log("Live check: read invoice, calculate, and write a new file...");
  const result = await invoke(["demo", "--allow-write", "--session", "live-check"]);
  report.run = result;
  store = new SessionStore(dataDirectory);
  const events = store.events(result.runId);
  report.events = events;
  const readIndex = events.findIndex((event) => event.tool === "read_file" && event.phase === "end" && event.ok);
  const calculateIndex = events.findIndex((event) => event.tool === "calculate" && event.phase === "start");
  const calculatedIndex = events.findIndex((event) => event.tool === "calculate" && event.phase === "end" && event.ok);
  const writeIndex = events.findIndex((event) => event.tool === "write_file" && event.phase === "start");
  assert.ok(readIndex >= 0 && calculateIndex > readIndex, "Calculation must follow the observed file contents.");
  assert.ok(calculatedIndex > calculateIndex && writeIndex > calculatedIndex, "Writing must follow the observed calculation.");
  assert.equal(JSON.parse(events[calculatedIndex].output).result, 703);
  const written = events.find((event) => event.tool === "write_file" && event.phase === "end" && event.ok);
  assert.ok(written, "The agent must successfully create a file.");
  const filename = JSON.parse(written.output).result.path;
  const artifact = await readFile(path.join(workspace, filename), "utf8");
  report.artifact = artifact;
  assert.match(artifact, /Local Workshop/i);
  assert.match(artifact, /\b703(?:\.00)?\b/);
  assert.match(artifact, /CAD/i);
  assert.equal(result.toolErrors, 0);
  assert.match(result.answer, /703/);
  assert.ok(store.history("live-check").length >= 7);
  store.close();
  store = undefined;
  console.log("Live check: resume the persisted session in a new process...");
  const followup = await invoke(["run", "What customer and invoice total did we just process? Answer from our previous conversation without tools.", "--session", "live-check"]);
  report.followup = followup;
  assert.match(followup.answer, /Local Workshop/i);
  assert.match(followup.answer, /703/);
  const stopped = await fetch(`${new URL(baseUrl).origin}/health`, { signal: AbortSignal.timeout(1000) })
    .then(() => false, () => true);
  assert.equal(stopped, true, "The CLI must stop the local model process it started.");
  report.modelStopped = stopped;
  report.ok = true;
  console.log("PASS: real model, ordered tools, correct artifact, durable session, and process cleanup.");
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`FAIL: ${report.error}`);
  process.exitCode = 1;
} finally {
  store?.close();
  await mkdir(path.join(root, ".spider"), { recursive: true });
  await writeFile(path.join(root, ".spider/verification.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(temporary, { recursive: true, force: true });
}