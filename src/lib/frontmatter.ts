import { LineCounter, parseDocument } from "yaml";

export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterValue = FrontmatterScalar | FrontmatterValue[] | { [key: string]: FrontmatterValue };
export type FrontmatterEntry = { key: string; value: FrontmatterValue };
export type FrontmatterError = { message: string; line: number; column: number };

export type Frontmatter =
  | { status: "none"; entries: []; body: string; offsetLines: 0 }
  | { status: "parsed"; entries: FrontmatterEntry[]; body: string; offsetLines: number }
  | { status: "error"; entries: []; body: string; offsetLines: 0; error: FrontmatterError };

type FrontmatterBlock = { yaml: string; body: string; offsetLines: number };

function frontmatterBlock(content: string): FrontmatterBlock | null {
  const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(content);
  if (!opening) return null;

  let lineStart = opening[0].length;
  while (lineStart <= content.length) {
    const newline = content.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    const line = content.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) {
      const blockEnd = newline === -1 ? lineEnd : newline + 1;
      const block = content.slice(0, blockEnd);
      return {
        yaml: content.slice(opening[0].length, lineStart),
        body: content.slice(blockEnd),
        offsetLines: (block.match(/\n/g) || []).length,
      };
    }
    if (newline === -1) return null;
    lineStart = newline + 1;
  }
  return null;
}

function normalizeValue(value: unknown, ancestors = new WeakSet<object>(), depth = 0): FrontmatterValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value === undefined ? null : String(value);
  if (depth >= 8) return "…";
  if (ancestors.has(value)) return "↻";

  ancestors.add(value);
  let normalized: FrontmatterValue;
  if (Array.isArray(value)) {
    normalized = value.map((item) => normalizeValue(item, ancestors, depth + 1));
  } else if (value instanceof Map) {
    normalized = Object.fromEntries(Array.from(value, ([key, item]) => [String(key), normalizeValue(item, ancestors, depth + 1)]));
  } else {
    normalized = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item, ancestors, depth + 1)]));
  }
  ancestors.delete(value);
  return normalized;
}

function parseError(error: { message: string; pos: [number, number] }, lineCounter: LineCounter): FrontmatterError {
  const position = lineCounter.linePos(error.pos[0]);
  return {
    message: error.message,
    line: position.line + 1,
    column: position.col,
  };
}

function failedFrontmatter(content: string, error: FrontmatterError): Frontmatter {
  return { status: "error", entries: [], body: content, offsetLines: 0, error };
}

export function parseFrontmatter(content: string): Frontmatter {
  const block = frontmatterBlock(content);
  if (!block) return { status: "none", entries: [], body: content, offsetLines: 0 };

  const lineCounter = new LineCounter();
  try {
    const document = parseDocument(block.yaml, {
      lineCounter,
      logLevel: "silent",
      prettyErrors: false,
      schema: "core",
      strict: true,
      uniqueKeys: true,
    });
    const problem = document.errors[0] || document.warnings[0];
    if (problem) return failedFrontmatter(content, parseError(problem, lineCounter));

    const value = document.toJS({ mapAsMap: false, maxAliasCount: 100 });
    if (value !== null && (typeof value !== "object" || Array.isArray(value) || value instanceof Date)) {
      return failedFrontmatter(content, { message: "Frontmatter must be a YAML mapping.", line: 2, column: 1 });
    }
    const mapping = value === null ? {} : value;
    const entries = Object.entries(mapping).map(([key, item]) => ({ key, value: normalizeValue(item) }));
    return { status: "parsed", entries, body: block.body, offsetLines: block.offsetLines };
  } catch (error) {
    const message = error instanceof Error ? error.message : "YAML could not be parsed.";
    return failedFrontmatter(content, { message, line: 2, column: 1 });
  }
}
