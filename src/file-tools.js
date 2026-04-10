import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";

const MAX_READ_CHARS = 24_000;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_FILE_SIZE = 1_000_000;
const MAX_COMMAND_OUTPUT_CHARS = 24_000;
const SKIP_DIRS = new Set([".git", "node_modules"]);

function normalizeWorkspaceRoot(workspaceRoot) {
  return path.resolve(workspaceRoot || process.cwd());
}

function isInsideWorkspace(targetPath, workspaceRoot) {
  if (targetPath === workspaceRoot) return true;
  return targetPath.startsWith(`${workspaceRoot}${path.sep}`);
}

function resolveWorkspacePath(workspaceRoot, targetPath = ".") {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const resolved = path.resolve(root, targetPath);
  if (!isInsideWorkspace(resolved, root)) {
    throw new Error(`Path "${targetPath}" is outside workspace root "${root}".`);
  }
  return resolved;
}

function toRelativeDisplayPath(workspaceRoot, absolutePath) {
  const relative = path.relative(normalizeWorkspaceRoot(workspaceRoot), absolutePath);
  return relative || ".";
}

function asLineNumberedText(content, startLineNumber = 1) {
  return content
    .split(/\r?\n/)
    .map((line, index) => `${startLineNumber + index}. ${line}`)
    .join("\n");
}

async function listDirectoryEntries(absolutePath, workspaceRoot, maxDepth, depth = 0) {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const output = [];
  for (const entry of entries) {
    const childAbsolute = path.join(absolutePath, entry.name);
    const childRelative = toRelativeDisplayPath(workspaceRoot, childAbsolute);

    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
      output.push({ path: childRelative, type: "directory", skipped: true });
      continue;
    }

    if (entry.isDirectory()) {
      output.push({ path: childRelative, type: "directory" });
      if (depth < maxDepth) {
        const nested = await listDirectoryEntries(childAbsolute, workspaceRoot, maxDepth, depth + 1);
        output.push(...nested);
      }
    } else {
      const stat = await fs.stat(childAbsolute);
      output.push({ path: childRelative, type: "file", size: stat.size });
    }
  }
  return output;
}

async function toolListDir(args, workspaceRoot) {
  const relativePath = args?.path ?? ".";
  const maxDepth = Number.isInteger(args?.depth) ? Math.max(0, Math.min(args.depth, 5)) : 2;
  const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isDirectory()) {
    throw new Error(`Path "${relativePath}" is not a directory.`);
  }
  const entries = await listDirectoryEntries(absolutePath, workspaceRoot, maxDepth, 0);
  return {
    path: toRelativeDisplayPath(workspaceRoot, absolutePath),
    depth: maxDepth,
    entries,
  };
}

async function toolReadFile(args, workspaceRoot) {
  const relativePath = args?.path;
  if (!relativePath) throw new Error(`"path" is required.`);

  const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
  const raw = await fs.readFile(absolutePath, "utf8");
  if (raw.includes("\u0000")) {
    throw new Error("File appears to be binary and cannot be read as text.");
  }

  const lines = raw.split(/\r?\n/);
  const startLine = Number.isInteger(args?.startLine) ? Math.max(1, args.startLine) : 1;
  const endLine = Number.isInteger(args?.endLine) ? Math.max(startLine, args.endLine) : lines.length;

  const selected = lines.slice(startLine - 1, endLine);
  let text = selected.join("\n");
  if (text.length > MAX_READ_CHARS) {
    text = `${text.slice(0, MAX_READ_CHARS)}\n...[truncated]`;
  }

  return {
    path: toRelativeDisplayPath(workspaceRoot, absolutePath),
    startLine,
    endLine: Math.min(endLine, lines.length),
    totalLines: lines.length,
    content: asLineNumberedText(text, startLine),
  };
}

async function toolWriteFile(args, workspaceRoot) {
  const relativePath = args?.path;
  if (!relativePath) throw new Error(`"path" is required.`);
  if (typeof args?.content !== "string") throw new Error(`"content" must be a string.`);

  const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
  const createDirs = args?.createDirs !== false;
  const overwrite = args?.overwrite !== false;

  if (createDirs) {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  }

  if (!overwrite) {
    try {
      await fs.access(absolutePath);
      throw new Error(`File "${relativePath}" already exists and overwrite=false.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  await fs.writeFile(absolutePath, args.content, "utf8");
  return {
    path: toRelativeDisplayPath(workspaceRoot, absolutePath),
    bytesWritten: Buffer.byteLength(args.content, "utf8"),
  };
}

async function toolAppendFile(args, workspaceRoot) {
  const relativePath = args?.path;
  if (!relativePath) throw new Error(`"path" is required.`);
  if (typeof args?.content !== "string") throw new Error(`"content" must be a string.`);

  const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.appendFile(absolutePath, args.content, "utf8");
  const stat = await fs.stat(absolutePath);
  return {
    path: toRelativeDisplayPath(workspaceRoot, absolutePath),
    size: stat.size,
  };
}

async function toolEditFile(args, workspaceRoot) {
  const relativePath = args?.path;
  if (!relativePath) throw new Error(`"path" is required.`);
  if (typeof args?.oldText !== "string") throw new Error(`"oldText" must be a string.`);
  if (typeof args?.newText !== "string") throw new Error(`"newText" must be a string.`);

  const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
  const content = await fs.readFile(absolutePath, "utf8");
  const replaceAll = args?.replaceAll === true;

  if (!content.includes(args.oldText)) {
    throw new Error(`oldText was not found in "${relativePath}".`);
  }

  let updatedContent = content;
  let replacements = 0;

  if (replaceAll) {
    updatedContent = content.split(args.oldText).join(args.newText);
    replacements = content.split(args.oldText).length - 1;
  } else {
    const index = content.indexOf(args.oldText);
    updatedContent =
      content.slice(0, index) + args.newText + content.slice(index + args.oldText.length);
    replacements = 1;
  }

  await fs.writeFile(absolutePath, updatedContent, "utf8");
  return {
    path: toRelativeDisplayPath(workspaceRoot, absolutePath),
    replacements,
  };
}

async function toolDeletePath(args, workspaceRoot) {
  const relativePath = args?.path;
  if (!relativePath) throw new Error(`"path" is required.`);
  const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
  const recursive = args?.recursive === true;
  await fs.rm(absolutePath, { recursive, force: false });
  return {
    path: toRelativeDisplayPath(workspaceRoot, absolutePath),
    deleted: true,
  };
}

async function toolMkdir(args, workspaceRoot) {
  const relativePath = args?.path;
  if (!relativePath) throw new Error(`"path" is required.`);
  const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
  await fs.mkdir(absolutePath, { recursive: args?.recursive !== false });
  return {
    path: toRelativeDisplayPath(workspaceRoot, absolutePath),
    created: true,
  };
}

async function toolMovePath(args, workspaceRoot) {
  const from = args?.from;
  const to = args?.to;
  if (!from || !to) throw new Error(`"from" and "to" are required.`);

  const fromAbsolute = resolveWorkspacePath(workspaceRoot, from);
  const toAbsolute = resolveWorkspacePath(workspaceRoot, to);
  await fs.mkdir(path.dirname(toAbsolute), { recursive: true });
  await fs.rename(fromAbsolute, toAbsolute);

  return {
    from: toRelativeDisplayPath(workspaceRoot, fromAbsolute),
    to: toRelativeDisplayPath(workspaceRoot, toAbsolute),
  };
}

async function walkFilesForSearch(absoluteDir, files = []) {
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkFilesForSearch(childPath, files);
      continue;
    }
    if (entry.isFile()) {
      files.push(childPath);
    }
  }
  return files;
}

async function toolSearchFiles(args, workspaceRoot) {
  const query = args?.query;
  if (!query || typeof query !== "string") {
    throw new Error(`"query" is required and must be a string.`);
  }

  const relativePath = args?.path ?? ".";
  const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isDirectory()) {
    throw new Error(`Path "${relativePath}" must be a directory for search_files.`);
  }

  const caseSensitive = args?.caseSensitive === true;
  const regex = args?.regex === true;
  const matcher = regex
    ? new RegExp(query, caseSensitive ? "g" : "gi")
    : null;
  const literalNeedle = caseSensitive ? query : query.toLowerCase();

  const matches = [];
  const files = await walkFilesForSearch(absolutePath);
  for (const fileAbsolute of files) {
    if (matches.length >= MAX_SEARCH_MATCHES) break;

    const fileStat = await fs.stat(fileAbsolute);
    if (fileStat.size > MAX_SEARCH_FILE_SIZE) continue;

    let content;
    try {
      content = await fs.readFile(fileAbsolute, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\u0000")) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i += 1) {
      const line = lines[i];
      let isMatch = false;
      if (regex) {
        matcher.lastIndex = 0;
        isMatch = matcher.test(line);
      } else {
        const haystack = caseSensitive ? line : line.toLowerCase();
        isMatch = haystack.includes(literalNeedle);
      }
      if (isMatch) {
        matches.push({
          path: toRelativeDisplayPath(workspaceRoot, fileAbsolute),
          line: i + 1,
          text: line,
        });
      }
    }
  }

  return {
    query,
    path: toRelativeDisplayPath(workspaceRoot, absolutePath),
    count: matches.length,
    truncated: matches.length >= MAX_SEARCH_MATCHES,
    matches,
  };
}

async function toolStatPath(args, workspaceRoot) {
  const relativePath = args?.path;
  if (!relativePath) throw new Error(`"path" is required.`);
  const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
  const stat = await fs.stat(absolutePath);
  return {
    path: toRelativeDisplayPath(workspaceRoot, absolutePath),
    type: stat.isDirectory() ? "directory" : "file",
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

async function toolRunCommand(args, workspaceRoot, context = {}) {
  const command = args?.command;
  if (!command || typeof command !== "string") {
    throw new Error(`"command" is required and must be a string.`);
  }

  const cwdRelative = args?.cwd ?? ".";
  const cwdAbsolute = resolveWorkspacePath(workspaceRoot, cwdRelative);
  const timeoutMsRaw = Number.isInteger(args?.timeoutMs) ? args.timeoutMs : 120_000;
  const timeoutMs = Math.max(1_000, Math.min(timeoutMsRaw, 300_000));

  if (typeof context.confirmCommand === "function") {
    const decision = await context.confirmCommand({
      command,
      cwd: toRelativeDisplayPath(workspaceRoot, cwdAbsolute),
      timeoutMs,
    });
    if (!decision?.approved) {
      throw new Error(
        decision?.reason || "Command execution was not approved by the user."
      );
    }
  }

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, {
      cwd: cwdAbsolute,
      shell: true,
      env: process.env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1500).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_COMMAND_OUTPUT_CHARS) {
        stdout += chunk.toString("utf8");
      }
    });

    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_COMMAND_OUTPUT_CHARS) {
        stderr += chunk.toString("utf8");
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd: toRelativeDisplayPath(workspaceRoot, cwdAbsolute),
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
      });
    });
  });
}

function truncateOutput(value) {
  if (value.length <= MAX_COMMAND_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_COMMAND_OUTPUT_CHARS)}\n...[truncated]`;
}

function globPatternToRegex(pattern) {
  // Convert a glob pattern to a RegExp. Supports *, **, ?, and {a,b} alternation.
  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        regexStr += ".*";
        i += 2;
        if (pattern[i] === "/") i += 1;
      } else {
        regexStr += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
      i += 1;
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        regexStr += "\\{";
        i += 1;
      } else {
        const alts = pattern
          .slice(i + 1, end)
          .split(",")
          .map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        regexStr += `(?:${alts.join("|")})`;
        i = end + 1;
      }
    } else if (/[.*+?^${}()|[\]\\]/.test(ch)) {
      regexStr += `\\${ch}`;
      i += 1;
    } else {
      regexStr += ch;
      i += 1;
    }
  }
  return new RegExp(`^${regexStr}$`);
}

const MAX_GLOB_MATCHES = 500;

async function toolGlobFiles(args, workspaceRoot) {
  const pattern = args?.pattern;
  if (!pattern || typeof pattern !== "string") {
    throw new Error(`"pattern" is required and must be a string (e.g. "**/*.js").`);
  }

  const relativePath = args?.path ?? ".";
  const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isDirectory()) {
    throw new Error(`Path "${relativePath}" must be a directory for glob_files.`);
  }

  const regex = globPatternToRegex(pattern);
  const matches = [];

  async function walkDir(dir, baseRelative) {
    if (matches.length >= MAX_GLOB_MATCHES) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= MAX_GLOB_MATCHES) break;
      if (SKIP_DIRS.has(entry.name)) continue;
      const childRelative = baseRelative ? `${baseRelative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walkDir(path.join(dir, entry.name), childRelative);
      } else {
        if (regex.test(childRelative)) {
          matches.push(childRelative);
        }
      }
    }
  }

  await walkDir(absolutePath, "");

  return {
    pattern,
    path: toRelativeDisplayPath(workspaceRoot, absolutePath),
    count: matches.length,
    truncated: matches.length >= MAX_GLOB_MATCHES,
    matches,
  };
}

async function toolPatchFile(args, workspaceRoot) {
  const relativePath = args?.path;
  if (!relativePath) throw new Error(`"path" is required.`);
  if (typeof args?.hunks !== "string" || !args.hunks.trim()) {
    throw new Error(`"hunks" is required and must be a unified-diff string.`);
  }

  const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
  const originalContent = await fs.readFile(absolutePath, "utf8");
  const originalLines = originalContent.split(/\r?\n/);

  const patchedLines = applyUnifiedDiff(originalLines, args.hunks);

  await fs.writeFile(absolutePath, patchedLines.join("\n"), "utf8");
  return {
    path: toRelativeDisplayPath(workspaceRoot, absolutePath),
    linesOriginal: originalLines.length,
    linesPatched: patchedLines.length,
  };
}

function applyUnifiedDiff(originalLines, hunksText) {
  // Parse and apply unified diff hunks (lines starting with @@).
  const hunkRegex = /^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@/;
  const diffLines = hunksText.split(/\r?\n/);
  const result = [...originalLines];
  let offset = 0;

  let i = 0;
  while (i < diffLines.length) {
    const headerMatch = diffLines[i].match(hunkRegex);
    if (!headerMatch) {
      i += 1;
      continue;
    }

    const origStart = Number.parseInt(headerMatch[1], 10) - 1;
    const hunkLines = [];
    i += 1;

    while (i < diffLines.length && !diffLines[i].match(hunkRegex)) {
      hunkLines.push(diffLines[i]);
      i += 1;
    }

    const removals = hunkLines.filter((l) => l.startsWith("-")).map((l) => l.slice(1));
    const additions = hunkLines.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
    const contextCount = hunkLines.filter((l) => l.startsWith(" ")).length;
    const removeCount = removals.length;

    const spliceAt = origStart + offset;
    result.splice(spliceAt, removeCount + contextCount, ...hunkLines
      .filter((l) => !l.startsWith("-"))
      .map((l) => l.slice(1)));
    offset += additions.length - removeCount;
  }

  return result;
}

const TOOL_HANDLERS = {
  list_dir: toolListDir,
  read_file: toolReadFile,
  write_file: toolWriteFile,
  append_file: toolAppendFile,
  edit_file: toolEditFile,
  delete_path: toolDeletePath,
  mkdir: toolMkdir,
  move_path: toolMovePath,
  search_files: toolSearchFiles,
  glob_files: toolGlobFiles,
  patch_file: toolPatchFile,
  stat_path: toolStatPath,
  run_command: toolRunCommand,
};

export const FILE_TOOL_DEFINITIONS = [
  { name: "list_dir", description: "List files/directories recursively from a path.", args: ["path?", "depth?"] },
  { name: "read_file", description: "Read a UTF-8 text file with optional line range.", args: ["path", "startLine?", "endLine?"] },
  { name: "write_file", description: "Write full file content (creates directories by default).", args: ["path", "content", "overwrite?", "createDirs?"] },
  { name: "append_file", description: "Append text to a file.", args: ["path", "content"] },
  { name: "edit_file", description: "Replace first/all occurrences of oldText in a file.", args: ["path", "oldText", "newText", "replaceAll?"] },
  { name: "delete_path", description: "Delete a file or directory (recursive optional).", args: ["path", "recursive?"] },
  { name: "mkdir", description: "Create a directory.", args: ["path", "recursive?"] },
  { name: "move_path", description: "Rename/move a file or directory.", args: ["from", "to"] },
  { name: "search_files", description: "Search text across files in a directory.", args: ["query", "path?", "caseSensitive?", "regex?"] },
  { name: "glob_files", description: "Find files matching a glob pattern (e.g. **/*.ts, src/*.js).", args: ["pattern", "path?"] },
  { name: "patch_file", description: "Apply a unified-diff patch string to a file.", args: ["path", "hunks"] },
  { name: "stat_path", description: "Get basic metadata for a file or directory.", args: ["path"] },
  { name: "run_command", description: "Run a shell command in workspace (requires user approval unless yolo).", args: ["command", "cwd?", "timeoutMs?"] },
];

export function formatToolDefinitionsForPrompt() {
  return FILE_TOOL_DEFINITIONS.map(
    (tool) => `- ${tool.name}: ${tool.description} Args: ${tool.args.join(", ")}`
  ).join("\n");
}

export async function executeFileToolCall(
  call,
  { workspaceRoot = process.cwd(), confirmCommand } = {}
) {
  const name = call?.name;
  const args = call?.arguments ?? {};
  if (!name || typeof name !== "string") {
    return { ok: false, error: 'Tool call must include a string "name".' };
  }

  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return { ok: false, error: `Unknown tool "${name}".` };
  }

  try {
    const result = await handler(args, workspaceRoot, { confirmCommand });
    return { ok: true, name, result };
  } catch (error) {
    return { ok: false, name, error: error.message };
  }
}
