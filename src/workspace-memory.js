import path from "node:path";
import { promises as fs } from "node:fs";

export const WORKSPACE_MEMORY_FILES = [
  "META.md",
  "METACODE.md",
  ".meta-code.md",
  ".meta-code/instructions.md",
  ".meta-code/memory.md",
];

const MAX_MEMORY_CHARS = 8000;

function isInsideRoot(absolutePath, rootPath) {
  return absolutePath === rootPath || absolutePath.startsWith(`${rootPath}${path.sep}`);
}

export async function loadWorkspaceMemory(workspaceRoot = process.cwd()) {
  const root = path.resolve(workspaceRoot);
  const sections = [];
  let remainingChars = MAX_MEMORY_CHARS;
  let truncated = false;

  for (const relativePath of WORKSPACE_MEMORY_FILES) {
    if (remainingChars <= 0) {
      truncated = true;
      break;
    }

    const absolutePath = path.resolve(root, relativePath);
    if (!isInsideRoot(absolutePath, root)) continue;

    let content;
    try {
      content = await fs.readFile(absolutePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    if (!content || content.includes("\u0000")) continue;
    const trimmed = content.trim();
    if (!trimmed) continue;

    let clipped = trimmed;
    if (clipped.length > remainingChars) {
      clipped = clipped.slice(0, remainingChars);
      truncated = true;
    }
    remainingChars -= clipped.length;

    sections.push({
      path: relativePath,
      content: clipped,
    });
  }

  const text = sections.map((entry) => `# ${entry.path}\n${entry.content}`).join("\n\n");
  return {
    text,
    sources: sections.map((entry) => entry.path),
    truncated,
  };
}
