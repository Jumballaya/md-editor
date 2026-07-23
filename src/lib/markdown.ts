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

function resolveReference(reference: string, baseUrl: string): string {
  if (reference.startsWith("#")) return reference;
  try {
    new URL(reference);
    return reference;
  } catch {
    try {
      return new URL(reference, baseUrl).toString();
    } catch {
      return reference;
    }
  }
}

function browserLinkBaseUrl(contentUrl: string): string {
  try {
    const url = new URL(contentUrl);
    if (url.hostname !== "raw.githubusercontent.com") return contentUrl;
    const [owner, repository, revision, ...file] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repository || !revision || !file.length) return contentUrl;
    return `https://github.com/${owner}/${repository}/blob/${revision}/${file.join("/")}`;
  } catch {
    return contentUrl;
  }
}

function resolveRemoteReferences(tokens: any[], contentUrl: string) {
  const linkBaseUrl = browserLinkBaseUrl(contentUrl);
  for (const token of tokens) {
    if (token.type === "image") {
      const source = token.attrGet("src");
      if (source) token.attrSet("src", resolveReference(source, contentUrl));
    } else if (token.type === "link_open") {
      const target = token.attrGet("href");
      if (target) token.attrSet("href", resolveReference(target, linkBaseUrl));
    }
    if (token.children) resolveRemoteReferences(token.children, contentUrl);
  }
}

md.core.ruler.after("inline", "remote_references", (state) => {
  const contentUrl = state.env?.contentUrl;
  if (typeof contentUrl === "string" && contentUrl) {
    resolveRemoteReferences(state.tokens, contentUrl);
  }
});

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

export function renderMarkdownMarkup(body: string, contentUrl?: string): string {
  return md.render(body, { contentUrl });
}

export function renderMarkdown(body: string, contentUrl?: string): string {
  const html = renderMarkdownMarkup(body, contentUrl);
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["data-source-line", "type", "checked", "disabled", "start"],
  });
}
