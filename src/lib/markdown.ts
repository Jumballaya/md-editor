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

export function renderMarkdown(body: string): string {
  const html = md.render(body);
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["data-source-line", "type", "checked", "disabled", "start"],
  });
}
