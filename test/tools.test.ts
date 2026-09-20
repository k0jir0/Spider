import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createWorkspaceTools, type ToolEvent } from "../src/tools.js";

async function fixture(context: TestContext, allowWrite = false) {
  const parent = await mkdtemp(path.join(tmpdir(), "spider-tools-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  const events: ToolEvent[] = [];
  const tools = await createWorkspaceTools(root, allowWrite, (event) => events.push(event));
  return {
    parent, root, events, tools,
    async invoke(name: string, input: Record<string, unknown>) {
      const selected = tools.find((entry) => entry.name === name);
      assert.ok(selected);
      return JSON.parse(String(await selected.invoke(input))) as { ok: boolean; result: unknown; error?: string };
    },
  };
}

test("arithmetic executes and reports divide-by-zero without crashing", async (context) => {
  const workspace = await fixture(context);
  assert.deepEqual(await workspace.invoke("calculate", { operation: "multiply", numbers: [37, 19] }), {
    ok: true, result: 703,
  });
  assert.equal((await workspace.invoke("calculate", { operation: "divide", numbers: [1, 0] })).ok, false);
  assert.equal(workspace.events.length, 4);
});

test("writes are absent by default", async (context) => {
  const workspace = await fixture(context);
  assert.equal(workspace.tools.some((entry) => entry.name === "write_file"), false);
});

test("opted-in writes create files but cannot overwrite them", async (context) => {
  const workspace = await fixture(context, true);
  assert.equal((await workspace.invoke("write_file", { path: "output/result.txt", content: "703" })).ok, true);
  assert.equal((await workspace.invoke("write_file", { path: "output/result.txt", content: "changed" })).ok, false);
  assert.equal(await readFile(path.join(workspace.root, "output/result.txt"), "utf8"), "703");
  assert.deepEqual((await workspace.invoke("read_file", { path: "output/result.txt" })).result, {
    path: "output/result.txt", text: "703",
  });
});

test("parent paths, hidden files, absolute paths, and Windows special paths are denied", async (context) => {
  const workspace = await fixture(context, true);
  for (const filename of ["../outside.txt", "..\\outside.txt", ".env", "C:\\outside.txt", "/tmp/outside", "note.txt:secret", "NUL.txt", "dir./file"]) {
    const result = await workspace.invoke("write_file", { path: filename, content: "blocked" });
    assert.equal(result.ok, false, filename);
    assert.match(result.error!, /relative workspace path/);
  }
});

test("junctions cannot escape the workspace", async (context) => {
  const workspace = await fixture(context, true);
  const outside = path.join(workspace.parent, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "private");
  await symlink(outside, path.join(workspace.root, "link"), "junction");
  assert.equal((await workspace.invoke("read_file", { path: "link/secret.txt" })).ok, false);
  assert.equal((await workspace.invoke("write_file", { path: "link/new.txt", content: "blocked" })).ok, false);
});

test("oversized and binary reads are refused", async (context) => {
  const workspace = await fixture(context);
  await writeFile(path.join(workspace.root, "large.txt"), "a".repeat(16_385));
  await writeFile(path.join(workspace.root, "binary.dat"), Buffer.from([0, 1, 2]));
  assert.equal((await workspace.invoke("read_file", { path: "large.txt" })).ok, false);
  assert.equal((await workspace.invoke("read_file", { path: "binary.dat" })).ok, false);
});

test("text search returns real filenames and line numbers", async (context) => {
  const workspace = await fixture(context);
  await writeFile(path.join(workspace.root, "notes.txt"), "first\nNeedle here\nlast");
  const result = await workspace.invoke("search_files", { directory: ".", query: "needle" });
  assert.deepEqual(result.result, {
    matches: [{ path: "notes.txt", line: 2, text: "Needle here" }], truncated: false, skipped: 0,
  });
});