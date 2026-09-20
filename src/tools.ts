import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

const MAX_FILE_BYTES = 16_384;
const MAX_ENTRIES = 100;

export interface ToolEvent {
  tool: string;
  phase: "start" | "end";
  input?: unknown;
  output?: string;
  ok?: boolean;
}

export async function createWorkspaceTools(
  directory: string,
  allowWrite = false,
  onEvent: (event: ToolEvent) => void = () => {},
): Promise<StructuredToolInterface[]> {
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);

  async function safePath(input: string, creating = false): Promise<string> {
    if (input === ".") return root;
    const parts = input.replaceAll("\\", "/").split("/");
    if (path.isAbsolute(input) || path.win32.isAbsolute(input) || parts.some((part) =>
      !part || part.startsWith(".") || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error("Use a relative workspace path without hidden, parent, or special path components.");
    }
    let current = root;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) {
          throw new Error("Symbolic links, junctions, and hard-linked files are not accessible.");
        }
      } catch (error) {
        if (creating && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    return current;
  }

  async function readText(input: string): Promise<string> {
    const filename = await safePath(input);
    const info = await lstat(filename);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      throw new Error(`Only text files up to ${MAX_FILE_BYTES} bytes can be read.`);
    }
    const bytes = await readFile(filename);
    if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) {
      throw new Error("The file is binary or exceeds the text size limit.");
    }
    return bytes.toString("utf8");
  }

  async function execute(name: string, input: unknown, action: () => Promise<unknown> | unknown) {
    onEvent({ tool: name, phase: "start", input });
    let output: string;
    let ok = false;
    try {
      const result = await action();
      ok = true;
      output = JSON.stringify({ ok, result });
    } catch (error) {
      output = JSON.stringify({ ok, error: error instanceof Error ? error.message : String(error) });
    }
    onEvent({ tool: name, phase: "end", output, ok });
    return output;
  }

  const tools: StructuredToolInterface[] = [
    tool((input) => execute("list_files", input, async () => {
      const entries = await readdir(await safePath(input.directory), { withFileTypes: true });
      const visible = entries.filter((entry) => !entry.name.startsWith(".") && !entry.isSymbolicLink())
        .sort((left, right) => left.name.localeCompare(right.name));
      return {
        entries: visible.slice(0, MAX_ENTRIES).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        })),
        truncated: visible.length > MAX_ENTRIES,
      };
    }), {
      name: "list_files",
      description: "List up to 100 visible entries in a workspace directory. Use '.' for the root.",
      schema: z.object({ directory: z.string().min(1).max(240) }),
    }),
    tool((input) => execute("read_file", input, async () => ({
      path: input.path,
      text: await readText(input.path),
    })), {
      name: "read_file",
      description: "Read a workspace text file, at most 16 KiB. The path is relative to the workspace.",
      schema: z.object({ path: z.string().min(1).max(240) }),
    }),
    tool((input) => execute("search_files", input, async () => {
      const entries = await readdir(await safePath(input.directory), { withFileTypes: true });
      const matches: { path: string; line: number; text: string }[] = [];
      let skipped = 0;
      const files = entries.filter((entry) => entry.isFile() && !entry.name.startsWith("."))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of files.slice(0, MAX_ENTRIES)) {
        const filename = path.posix.join(input.directory.replaceAll("\\", "/"), entry.name);
        let content: string;
        try { content = await readText(filename); } catch { skipped += 1; continue; }
        for (const [index, line] of content.split(/\r?\n/).entries()) {
          if (line.toLowerCase().includes(input.query.toLowerCase())) {
            matches.push({ path: filename, line: index + 1, text: line.slice(0, 250) });
            if (matches.length === 20) return { matches, truncated: true, skipped };
          }
        }
      }
      return { matches, truncated: files.length > MAX_ENTRIES, skipped };
    }), {
      name: "search_files",
      description: "Literal case-insensitive text search in up to 100 small files in one directory, not recursive.",
      schema: z.object({ directory: z.string().min(1).max(240), query: z.string().min(1).max(200) }),
    }),
    tool((input) => execute("calculate", input, () => {
      const [first, ...rest] = input.numbers;
      let result = first!;
      for (const number of rest) {
        switch (input.operation) {
          case "add": result += number; break;
          case "subtract": result -= number; break;
          case "multiply": result *= number; break;
          case "divide":
            if (number === 0) throw new Error("Division by zero is not allowed.");
            result /= number;
        }
      }
      if (!Number.isFinite(result)) throw new Error("The result is outside the finite number range.");
      return result;
    }), {
      name: "calculate",
      description: "Calculate using real arithmetic. Apply the operation left to right to the supplied numbers.",
      schema: z.object({
        operation: z.enum(["add", "subtract", "multiply", "divide"]),
        numbers: z.array(z.number()).min(2).max(20),
      }),
    }),
  ];

  if (allowWrite) {
    tools.push(tool((input) => execute("write_file", input, async () => {
      if (Buffer.byteLength(input.content) > MAX_FILE_BYTES) throw new Error("Write limit is 16 KiB.");
      const filename = await safePath(input.path, true);
      await mkdir(path.dirname(filename), { recursive: true });
      await safePath(input.path, true);
      await writeFile(filename, input.content, { encoding: "utf8", flag: "wx" });
      return { path: input.path, bytes: Buffer.byteLength(input.content), created: true };
    }), {
      name: "write_file",
      description: "Create a NEW workspace text file. Existing files are never overwritten; choose a new name.",
      schema: z.object({ path: z.string().min(1).max(240), content: z.string().max(MAX_FILE_BYTES) }),
    }));
  }
  return tools;
}