import MarkdownIt from "markdown-it";
// @ts-ignore - no bundled types
import taskLists from "markdown-it-task-lists";
import DOMPurify from "dompurify";

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false, // keep characters identical to source (no smart quotes)
  breaks: false,
});
md.use(taskLists, { enabled: true, label: false });

// Stamp every block token that carries a source map with data-source-line so
// the preview DOM can be mapped back to editor lines (VS Code's approach).
md.core.ruler.push("source_line", (state) => {
  for (const token of state.tokens) stamp(token);
});
function stamp(token: any) {
  if (token.map && token.nesting !== -1) {
    token.attrSet("data-source-line", String(token.map[0]));
  }
  if (token.children) for (const c of token.children) if (c.map) stamp(c);
}

export type FrontValue = string | string[] | boolean;
export type Frontmatter = { entries: { key: string; value: FrontValue }[]; body: string; offsetLines: number };

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}
function parseScalar(s: string): FrontValue {
  const t = s.trim();
  if (/^\[.*\]$/.test(t)) return t.slice(1, -1).split(",").map(unquote).filter((x) => x.length > 0);
  if (t === "true") return true;
  if (t === "false") return false;
  return unquote(t);
}

// Split a leading YAML frontmatter block off the content. offsetLines is the
// number of document lines the block occupies (so preview line N maps to
// document line N + offsetLines).
export function parseFrontmatter(content: string): Frontmatter {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  if (!m) return { entries: [], body: content, offsetLines: 0 };
  const block = m[0];
  const body = content.slice(block.length);
  const offsetLines = (block.match(/\r?\n/g) || []).length;
  const lines = m[1].split(/\r?\n/);
  const entries: { key: string; value: FrontValue }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const km = /^([A-Za-z0-9_.\-]+):\s*(.*)$/.exec(line);
    if (!km) continue;
    const key = km[1];
    const rest = km[2];
    if (rest === "") {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(unquote(lines[++i].replace(/^\s*-\s+/, "")));
      entries.push({ key, value: items.length ? items : "" });
    } else {
      entries.push({ key, value: parseScalar(rest) });
    }
  }
  return { entries, body, offsetLines };
}

export function renderMarkdown(body: string): string {
  const html = md.render(body);
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["data-source-line", "type", "checked", "disabled", "start"],
  });
}
