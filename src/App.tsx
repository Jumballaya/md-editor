import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  FileText, Plus, Upload, Download, Trash2, Sun, Moon, Pencil, Check,
  ChevronDown, SlidersHorizontal, Lock, LockOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ResizablePanelGroup, ResizablePanel, ResizableHandle,
} from "@/components/ui/resizable";

marked.setOptions({ gfm: true, breaks: false });

const LS_FILES = "mdedit.files.v2";
const LS_ACTIVE = "mdedit.activeId.v2";
const LS_THEME = "mdedit.theme.v2";
const AUTOSAVE_DEBOUNCE = 800;
const AUTOSAVE_INTERVAL = 15000;

type MdFile = { id: string; title: string; content: string; updated: number };
type Theme = "light" | "dark";

function uid() {
  return "f_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}
const WELCOME =
  "# Welcome\n\nA **live markdown editor** built with shadcn/ui.\n\n- Type on the left in monospace\n- See the _GitHub-styled_ render on the right\n- Drag the center handle to resize (position is remembered)\n- Toggle light / dark up top\n- Content **autosaves**; rename with the inline button; **Download** exports `.md`\n\n```ts\nconsole.log('everything persists to localStorage');\n```\n\n> Multiple files, one at a time. Use the dropdown up top.\n";

type FrontValue = string | string[] | boolean;
type Frontmatter = { entries: { key: string; value: FrontValue }[]; body: string };

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}
function parseScalar(s: string): FrontValue {
  const t = s.trim();
  if (/^\[.*\]$/.test(t)) {
    return t.slice(1, -1).split(",").map(unquote).filter((x) => x.length > 0);
  }
  if (t === "true") return true;
  if (t === "false") return false;
  return unquote(t);
}
// Extract a leading YAML frontmatter block (--- ... ---). Returns the parsed
// key/value entries plus the body with the block removed. If there is no
// well-formed leading block, entries is empty and body is the original text.
function parseFrontmatter(text: string): Frontmatter {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { entries: [], body: text };
  const body = text.slice(m[0].length);
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
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(unquote(lines[++i].replace(/^\s*-\s+/, "")));
      }
      entries.push({ key, value: items.length ? items : "" });
    } else {
      entries.push({ key, value: parseScalar(rest) });
    }
  }
  return { entries, body };
}

function renderFrontValue(value: FrontValue) {
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-muted-foreground">-</span>;
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.map((item, i) => (
          <span key={i} className="rounded-full border px-2 py-0.5 text-xs">
            {item}
          </span>
        ))}
      </div>
    );
  }
  if (typeof value === "boolean") {
    return (
      <span
        className={
          "inline-block rounded-full px-2 py-0.5 text-xs font-medium " +
          (value ? "bg-brand/20 text-foreground" : "bg-secondary text-muted-foreground")
        }
      >
        {value ? "true" : "false"}
      </span>
    );
  }
  if (!value) return <span className="text-muted-foreground">-</span>;
  return <span className="break-words">{value}</span>;
}

// --- Selection mirroring: match selected text across the two panes ---
type SourceMap = { txt: string; map: number[]; norm: string; nmap: number[] };
type PreviewIndex = { norm: string; nodes: Node[]; offs: number[] };

function collapseWs(str: string): string {
  return str.replace(/\s+/g, " ");
}
function decodeEntities(str: string): string {
  if (str.indexOf("&") === -1) return str;
  return str
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// Build a markdown source map: the rendered plain text (markers stripped) plus,
// per character, the index back into the raw `content`. This lets a selection on
// one pane map to the corresponding text on the other even across list bullets,
// emphasis (**/_), inline code, headings, and blockquote markers.
function buildSourceMap(content: string): SourceMap {
  const { body } = parseFrontmatter(content);
  const fmOffset = content.length - body.length;
  let tokens: any[] = [];
  try { tokens = (marked as any).lexer(body); } catch { tokens = []; }

  let cursor = 0;
  let txt = "";
  const map: number[] = [];

  const emit = (visIn: string) => {
    let vis = decodeEntities(visIn);
    if (!vis) return;
    let at = body.indexOf(vis, cursor);
    if (at < 0) {
      const tv = vis.trim();
      if (tv) { at = body.indexOf(tv, cursor); if (at >= 0) vis = tv; }
    }
    if (at < 0) {
      for (let i = 0; i < vis.length; i++) { txt += vis[i]; map.push(cursor + fmOffset); }
      return;
    }
    for (let i = 0; i < vis.length; i++) { txt += vis[i]; map.push(at + i + fmOffset); }
    cursor = at + vis.length;
  };
  const sep = () => { txt += "\n"; map.push(cursor + fmOffset); };

  const inline = (toks: any[]) => {
    for (const t of toks || []) {
      switch (t.type) {
        case "text": t.tokens ? inline(t.tokens) : emit(t.text ?? t.raw); break;
        case "escape": emit(t.text); break;
        case "strong": case "em": case "del": inline(t.tokens || []); break;
        case "codespan": emit(t.text); break;
        case "link": inline(t.tokens || []); break;
        case "image": emit(t.text || ""); break;
        case "br": txt += " "; map.push(cursor + fmOffset); break;
        case "html": break;
        default: if (t.tokens) inline(t.tokens); else if (t.text) emit(t.text); break;
      }
    }
  };
  const blocks = (toks: any[]) => {
    for (const t of toks || []) {
      switch (t.type) {
        case "heading": case "paragraph": inline(t.tokens || []); sep(); break;
        case "text": t.tokens ? inline(t.tokens) : emit(t.text ?? t.raw); sep(); break;
        case "blockquote": blocks(t.tokens || []); break;
        case "list": for (const it of t.items || []) { blocks(it.tokens || []); sep(); } break;
        case "code": emit(t.text || ""); sep(); break;
        case "table":
          for (const cell of t.header || []) { inline(cell.tokens || []); sep(); }
          for (const row of t.rows || []) for (const cell of row || []) { inline(cell.tokens || []); sep(); }
          break;
        case "space": case "hr": case "html": break;
        default: if (t.tokens) blocks(t.tokens); break;
      }
    }
  };
  blocks(tokens);

  // whitespace-collapsed view + map back to txt indices
  let norm = "";
  const nmap: number[] = [];
  let prev = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (/\s/.test(c)) { if (!prev) { norm += " "; nmap.push(i); prev = true; } }
    else { norm += c; nmap.push(i); prev = false; }
  }
  return { txt, map, norm, nmap };
}
// Same for the rendered preview, mapping each normalized char back to a
// (text node, offset) so we can build a Range for the CSS Custom Highlight.
function buildPreviewIndex(root: HTMLElement): PreviewIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let norm = "";
  const nodes: Node[] = [];
  const offs: number[] = [];
  let prevSpace = false;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = node.nodeValue ?? "";
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (/\s/.test(c)) {
        if (!prevSpace) { norm += " "; nodes.push(node); offs.push(i); prevSpace = true; }
      } else { norm += c; nodes.push(node); offs.push(i); prevSpace = false; }
    }
  }
  return { norm, nodes, offs };
}

function countBelow(arr: number[], val: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < val) lo = m + 1; else hi = m; }
  return lo;
}
function closestOccurrence(hay: string, needle: string, expected: number): number {
  let best = -1, bestD = Infinity, from = 0, idx = hay.indexOf(needle, 0);
  while (idx !== -1) {
    const d = Math.abs(idx - expected);
    if (d < bestD) { bestD = d; best = idx; }
    from = idx + 1;
    idx = hay.indexOf(needle, from);
  }
  return best;
}
function domNormIndex(pi: PreviewIndex, node: Node, offset: number): number {
  for (let i = 0; i < pi.nodes.length; i++) if (pi.nodes[i] === node && pi.offs[i] >= offset) return i;
  let last = -1;
  for (let i = 0; i < pi.nodes.length; i++) if (pi.nodes[i] === node) last = i;
  return last >= 0 ? last + 1 : 0;
}

// First non-blank text node inside an element (for scroll anchoring).
function firstTextNode(el: Node): Node | null {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n = w.nextNode();
  while (n && !(n.nodeValue && n.nodeValue.trim())) n = w.nextNode();
  return n;
}

function loadFiles(): MdFile[] {
  try {
    const raw = localStorage.getItem(LS_FILES);
    const parsed = raw ? (JSON.parse(raw) as MdFile[]) : [];
    if (parsed.length) return parsed;
  } catch { /* ignore */ }
  return [{ id: uid(), title: "Welcome", content: WELCOME, updated: Date.now() }];
}

function initialTheme(): Theme {
  const stored = localStorage.getItem(LS_THEME);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const boot = useRef(
    (() => {
      const list = loadFiles();
      localStorage.setItem(LS_FILES, JSON.stringify(list)); // stabilize ids across reloads
      const stored = localStorage.getItem(LS_ACTIVE);
      const id = list.some((f) => f.id === stored) ? (stored as string) : list[0].id;
      return { list, id };
    })()
  );
  const [files, setFiles] = useState<MdFile[]>(boot.current.list);
  const [activeId, setActiveId] = useState<string>(boot.current.id);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [status, setStatus] = useState<{ kind: "saved" | "saving"; at?: string }>({ kind: "saved" });
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const [showMeta, setShowMeta] = useState(true);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLElement | null>(null);
  const mirrorHlRef = useRef<any>(null);
  const previewIndexRef = useRef<PreviewIndex | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollSyncingRef = useRef(false);
  const anchorsRef = useRef<{ raw: number; prev: number }[]>([]);
  const [locked, setLocked] = useState<boolean>(() => localStorage.getItem("mdedit.lock.v1") === "1");
  const sourceMap = useMemo(() => buildSourceMap(content), [content]);
  const sourceMapRef = useRef(sourceMap);
  sourceMapRef.current = sourceMap;

  const dirtyRef = useRef(false);
  const debounceRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const active = useMemo(() => files.find((f) => f.id === activeId) ?? null, [files, activeId]);

  // ---- theme ----
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.setAttribute("data-color-mode", theme);
    root.setAttribute("data-light-theme", "light");
    root.setAttribute("data-dark-theme", "dark");
    localStorage.setItem(LS_THEME, theme);
  }, [theme]);

  // ---- load active file into editor ----
  useEffect(() => {
    if (!active) return;
    setContent(active.content);
    setTitle(active.title);
    dirtyRef.current = false;
    setStatus({ kind: "saved", at: timeStr() });
    localStorage.setItem(LS_ACTIVE, active.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ---- persist files whenever they change ----
  useEffect(() => {
    localStorage.setItem(LS_FILES, JSON.stringify(files));
  }, [files]);

  const { entries: frontmatter, body } = useMemo(
    () => parseFrontmatter(content),
    [content]
  );
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(body) as string),
    [body]
  );

  function timeStr() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  const commitContent = useCallback(() => {
    if (!dirtyRef.current) return;
    setFiles((prev) =>
      prev.map((f) => (f.id === activeId ? { ...f, content, updated: Date.now() } : f))
    );
    dirtyRef.current = false;
    setStatus({ kind: "saved", at: timeStr() });
  }, [activeId, content]);

  // debounce + interval autosave
  useEffect(() => {
    const t = window.setInterval(() => { if (dirtyRef.current) commitContent(); }, AUTOSAVE_INTERVAL);
    return () => window.clearInterval(t);
  }, [commitContent]);

  function onContentChange(v: string) {
    setContent(v);
    dirtyRef.current = true;
    setStatus({ kind: "saving" });
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => commitContent(), AUTOSAVE_DEBOUNCE);
  }

  const titleDirty = !!active && title.trim() !== active.title;

  function saveTitle() {
    if (!active) return;
    const t = title.trim() || "Untitled";
    setTitle(t);
    setFiles((prev) => prev.map((f) => (f.id === activeId ? { ...f, title: t, updated: Date.now() } : f)));
    setStatus({ kind: "saved", at: timeStr() });
  }

  function switchFile(id: string) {
    commitContent();
    setActiveId(id);
  }

  function newFile() {
    commitContent();
    const f: MdFile = { id: uid(), title: "Untitled", content: "", updated: Date.now() };
    setFiles((prev) => [...prev, f]);
    setActiveId(f.id);
  }

  function isMarkdownFile(f: File) {
    return /\.(md|markdown|mdx|txt)$/i.test(f.name) || f.type === "text/markdown" || f.type === "text/plain";
  }

  async function uploadFiles(list: FileList | File[] | null) {
    if (!list || !("length" in list) || !list.length) return;
    commitContent();
    const created: MdFile[] = [];
    for (const file of Array.from(list)) {
      let text = "";
      try { text = await file.text(); } catch { continue; }
      const title = file.name.replace(/\.(md|markdown|mdx|txt)$/i, "").trim() || "Untitled";
      created.push({ id: uid(), title, content: text, updated: Date.now() });
    }
    if (!created.length) return;
    setFiles((prev) => [...prev, ...created]);
    setActiveId(created[0].id);
  }

  function deleteActive() {
    if (!active) return;
    if (!confirm(`Delete "${active.title || "Untitled"}"? This cannot be undone.`)) return;
    setFiles((prev) => {
      const next = prev.filter((f) => f.id !== active.id);
      if (!next.length) {
        const f = { id: uid(), title: "Untitled", content: "", updated: Date.now() };
        setActiveId(f.id);
        return [f];
      }
      setActiveId(next[0].id);
      return next;
    });
  }

  function downloadActive() {
    commitContent();
    const name = (title || "untitled").replace(/[\\/:*?"<>|]+/g, "_").trim() || "untitled";
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${name}.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Register a CSS Custom Highlight for the preview mirror (Chromium/modern).
  useEffect(() => {
    const g = window as any;
    if (!g.Highlight || !(CSS as any).highlights) return;
    const hl = new g.Highlight();
    (CSS as any).highlights.set("md-mirror", hl);
    mirrorHlRef.current = hl;
    return () => {
      (CSS as any).highlights.delete("md-mirror");
      mirrorHlRef.current = null;
    };
  }, []);

  // Rebuild the preview text index whenever the rendered HTML changes.
  useEffect(() => {
    if (previewRef.current) previewIndexRef.current = buildPreviewIndex(previewRef.current);
    mirrorHlRef.current?.clear?.();
    requestAnimationFrame(() => recomputeAnchors());
  }, [html]);

  // Mirror the selection from one pane onto the other.
  useEffect(() => {
    function mirrorFromRaw() {
      const ta = editorRef.current;
      const hl = mirrorHlRef.current;
      const pi = previewIndexRef.current;
      const sm = sourceMapRef.current;
      if (!ta || !hl || !pi || !sm) return;
      hl.clear();
      if (backdropRef.current) backdropRef.current.innerHTML = "";
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      // rendered-text range whose source indices fall inside the raw selection
      let a = -1;
      let b = -1;
      for (let i = 0; i < sm.map.length; i++) { if (sm.map[i] >= s) { a = i; break; } }
      for (let i = sm.map.length - 1; i >= 0; i--) { if (sm.map[i] < e) { b = i + 1; break; } }
      if (a < 0 || b <= a) return;
      const needle = collapseWs(sm.txt.slice(a, b)).trim();
      if (needle.length < 2) return;
      const expected = countBelow(sm.nmap, a);
      const idx = closestOccurrence(pi.norm, needle, expected);
      if (idx < 0) return;
      const end = idx + needle.length - 1;
      try {
        const r = document.createRange();
        r.setStart(pi.nodes[idx], pi.offs[idx]);
        r.setEnd(pi.nodes[end], pi.offs[end] + 1);
        hl.add(r);
      } catch { /* stale nodes */ }
    }
    function paintRaw(start: number, stop: number) {
      const inner = backdropRef.current;
      const ta = editorRef.current;
      if (!inner || !ta) return;
      const v = ta.value;
      inner.innerHTML =
        escapeHtml(v.slice(0, start)) +
        '<mark class="raw-mark">' +
        escapeHtml(v.slice(start, stop)) +
        "</mark>" +
        escapeHtml(v.slice(stop));
      inner.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    }
    function clearRaw() {
      if (backdropRef.current) backdropRef.current.innerHTML = "";
    }
    function mirrorFromPreview(sel: Selection) {
      const ta = editorRef.current;
      const sm = sourceMapRef.current;
      if (!ta || !sm) return;
      const needle = collapseWs(sel.toString()).trim();
      if (needle.length < 2) { clearRaw(); return; }
      const pi = previewIndexRef.current;
      let expected = 0;
      try { const rg = sel.getRangeAt(0); if (pi) expected = domNormIndex(pi, rg.startContainer, rg.startOffset); } catch { /* no range */ }
      const idx = closestOccurrence(sm.norm, needle, expected);
      if (idx < 0) { clearRaw(); return; }
      const ts = sm.nmap[idx];
      const te = sm.nmap[idx + needle.length - 1] + 1;
      const start = sm.map[ts];
      const stop = sm.map[te - 1] + 1;
      paintRaw(start, stop);
    }
    function onSel() {
      const ta = editorRef.current;
      const sel = window.getSelection();
      if (ta && document.activeElement === ta && ta.selectionStart !== ta.selectionEnd) {
        mirrorFromRaw();
        return;
      }
      if (sel && !sel.isCollapsed && previewRef.current && previewRef.current.contains(sel.anchorNode)) {
        mirrorHlRef.current?.clear?.();
        mirrorFromPreview(sel);
        return;
      }
      mirrorHlRef.current?.clear?.();
      if (backdropRef.current) backdropRef.current.innerHTML = "";
    }
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; onSel(); });
    };
    document.addEventListener("selectionchange", schedule);
    return () => {
      document.removeEventListener("selectionchange", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Drag-and-drop markdown files onto the window to open them.
  function dragHasFiles(e: React.DragEvent) {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }
  function onDragEnter(e: React.DragEvent) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function onDragLeave(e: React.DragEvent) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files).filter(isMarkdownFile);
    if (files.length) void uploadFiles(files);
  }

  // Recompute scroll anchors when the panes resize (splitter drag, window resize).
  useEffect(() => {
    const ro = new ResizeObserver(() => recomputeAnchors());
    if (previewScrollRef.current) ro.observe(previewScrollRef.current);
    if (editorRef.current) ro.observe(editorRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop the browser/Electron from navigating to a file dropped outside the target.
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // Cmd/Ctrl+S flush
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (titleDirty) saveTitle();
        commitContent();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function syncBackdrop() {
    const inner = backdropRef.current;
    const ta = editorRef.current;
    if (inner && ta) inner.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
  }

  useEffect(() => {
    localStorage.setItem("mdedit.lock.v1", locked ? "1" : "0");
  }, [locked]);

  // Build (rawY, previewY) anchor pairs by mapping each rendered block back to
  // its source line, so locked scrolling keeps blocks aligned even when the two
  // sides have very different heights.
  function recomputeAnchors() {
    const editor = editorRef.current;
    const pscroll = previewScrollRef.current;
    const art = previewRef.current;
    const sm = sourceMapRef.current;
    const pi = previewIndexRef.current;
    if (!editor || !pscroll || !art || !sm || !pi) { anchorsRef.current = []; return; }
    const cs = getComputedStyle(editor);
    const lh = parseFloat(cs.lineHeight) || 20;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const content = editor.value;
    const cTop = pscroll.getBoundingClientRect().top;
    const list: { raw: number; prev: number }[] = [{ raw: 0, prev: 0 }];
    for (const el of Array.from(art.children) as HTMLElement[]) {
      const tn = firstTextNode(el);
      if (!tn) continue;
      const di = domNormIndex(pi, tn, 0);
      if (di < 0 || di >= sm.nmap.length) continue;
      const ci = sm.map[sm.nmap[di]];
      if (ci == null) continue;
      let line = 0;
      for (let i = 0; i < ci && i < content.length; i++) if (content[i] === "\n") line++;
      const raw = padTop + line * lh;
      const prev = el.getBoundingClientRect().top - cTop + pscroll.scrollTop;
      list.push({ raw, prev });
    }
    list.push({
      raw: Math.max(0, editor.scrollHeight - editor.clientHeight),
      prev: Math.max(0, pscroll.scrollHeight - pscroll.clientHeight),
    });
    list.sort((a, b) => a.raw - b.raw);
    for (let i = 1; i < list.length; i++) if (list[i].prev < list[i - 1].prev) list[i].prev = list[i - 1].prev;
    anchorsRef.current = list;
  }
  function interpAnchor(val: number, fromKey: "raw" | "prev", toKey: "raw" | "prev"): number | null {
    const a = anchorsRef.current;
    if (a.length < 2) return null;
    if (val <= a[0][fromKey]) return a[0][toKey];
    for (let i = 0; i < a.length - 1; i++) {
      const lo = a[i], hi = a[i + 1];
      if (val >= lo[fromKey] && val <= hi[fromKey]) {
        const span = hi[fromKey] - lo[fromKey];
        const f = span > 0 ? (val - lo[fromKey]) / span : 0;
        return lo[toKey] + f * (hi[toKey] - lo[toKey]);
      }
    }
    return a[a.length - 1][toKey];
  }
  function onEditorScroll() {
    syncBackdrop();
    if (!locked || scrollSyncingRef.current) return;
    const from = editorRef.current;
    const to = previewScrollRef.current;
    if (!from || !to) return;
    if (!anchorsRef.current.length) recomputeAnchors();
    const target = interpAnchor(from.scrollTop, "raw", "prev");
    if (target == null) return;
    scrollSyncingRef.current = true;
    to.scrollTop = target;
    requestAnimationFrame(() => { scrollSyncingRef.current = false; });
  }
  function onPreviewScroll() {
    if (!locked || scrollSyncingRef.current) return;
    const from = previewScrollRef.current;
    const to = editorRef.current;
    if (!from || !to) return;
    if (!anchorsRef.current.length) recomputeAnchors();
    const target = interpAnchor(from.scrollTop, "prev", "raw");
    if (target == null) return;
    scrollSyncingRef.current = true;
    to.scrollTop = target;
    syncBackdrop();
    requestAnimationFrame(() => { scrollSyncingRef.current = false; });
  }

  function onEditorKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab") {
      e.preventDefault();
      const el = e.currentTarget;
      const s = el.selectionStart, en = el.selectionEnd;
      const next = content.slice(0, s) + "  " + content.slice(en);
      onContentChange(next);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
    }
  }

  return (
    <div
      className="relative flex h-full flex-col bg-background text-foreground"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-brand px-10 py-8 text-center">
            <Upload className="h-8 w-8 text-brand" />
            <div className="text-base font-semibold">Drop markdown files to open</div>
            <div className="text-xs text-muted-foreground">.md .markdown .mdx .txt</div>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <header className="flex flex-none flex-wrap items-center gap-2 border-b bg-card px-4 py-2.5">
        <div className="flex select-none items-center gap-2 pr-1 font-semibold tracking-tight">
          <span className="h-3.5 w-3.5 rotate-45 rounded-[4px] bg-gradient-to-br from-brand via-[#579fb5] to-muted-foreground shadow-sm" />
          Markdown
          <span className="hidden font-normal text-muted-foreground sm:inline">live editor</span>
        </div>
        <Separator orientation="vertical" className="mx-1 h-6" />

        <div className="relative">
          <FileText className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Select value={activeId} onValueChange={switchFile}>
            <SelectTrigger className="w-[190px] pl-8 font-medium">
              <SelectValue placeholder="Select a file" />
            </SelectTrigger>
            <SelectContent>
              {files.map((f) => (
                <SelectItem key={f.id} value={f.id}>{f.title || "Untitled"}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="relative flex min-w-[190px] flex-1 items-center">
          <Pencil className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={title}
            placeholder="Untitled"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveTitle(); } }}
            className="pl-8 font-medium"
            style={{ paddingRight: titleDirty ? 84 : undefined }}
          />
          {titleDirty && (
            <Button size="sm" variant="secondary" onClick={saveTitle}
              className="absolute right-1 h-7 px-2.5">
              <Check className="h-3.5 w-3.5" /> Rename
            </Button>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,.mdx,.txt,text/markdown,text/plain"
          multiple
          className="hidden"
          onChange={(e) => { void uploadFiles(e.target.files); e.currentTarget.value = ""; }}
        />
        <Button variant="outline" onClick={newFile}><Plus /> New</Button>
        <Button variant="outline" onClick={() => fileInputRef.current?.click()}><Upload /> Upload</Button>
        <Button onClick={downloadActive}><Download /> Download</Button>
        <Button variant="ghost" onClick={deleteActive}
          className="text-muted-foreground hover:bg-destructive hover:text-destructive-foreground">
          <Trash2 /> Delete
        </Button>

        <Separator orientation="vertical" className="mx-1 h-6" />
        <Button
          variant="outline"
          size="icon"
          aria-pressed={locked}
          title={locked ? "Scroll locked — click to unlock" : "Lock scroll between panes"}
          onClick={() => setLocked((v) => !v)}
          className={locked ? "border-brand bg-brand/15 text-foreground" : ""}
        >
          {locked ? <Lock /> : <LockOpen />}
        </Button>
        <Button variant="outline" size="icon" title="Toggle theme"
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>
          {theme === "dark" ? <Sun /> : <Moon />}
        </Button>

        <div className="ml-auto flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
          <span className={`h-1.5 w-1.5 rounded-full ${status.kind === "saving" ? "animate-pulse bg-[#e79d26]" : "bg-brand"}`} />
          {status.kind === "saving" ? "Saving…" : `Saved · ${status.at ?? timeStr()}`}
        </div>
      </header>

      {/* Split */}
      <ResizablePanelGroup direction="horizontal" autoSaveId="mdedit-split" className="flex-1">
        <ResizablePanel defaultSize={50} minSize={20} className="flex flex-col">
          <div className="flex h-[34px] flex-none items-center gap-2 border-b bg-card px-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
            RAW <span className="opacity-40">·</span> markdown
          </div>
          <div className="relative min-h-0 flex-1">
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <div
                ref={backdropRef}
                aria-hidden
                className="whitespace-pre p-6 font-mono text-[13.5px] leading-[1.75] text-transparent will-change-transform"
                style={{ tabSize: 2 }}
              />
            </div>
            <Textarea
              id="md-raw"
              ref={editorRef}
              value={content}
              spellCheck={false}
              onChange={(e) => onContentChange(e.target.value)}
              onKeyDown={onEditorKeyDown}
              onScroll={onEditorScroll}
              placeholder="# Start typing markdown..."
              className="absolute inset-0 h-full w-full resize-none overflow-auto whitespace-pre rounded-none bg-transparent p-6 font-mono text-[13.5px] leading-[1.75] caret-[hsl(var(--brand))] focus-visible:ring-0"
              style={{ tabSize: 2 }}
            />
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={50} minSize={20} className="flex flex-col">
          <div className="flex h-[34px] flex-none items-center gap-2 border-b bg-card px-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
            PREVIEW <span className="opacity-40">·</span> github <span className="text-brand">●</span>
          </div>
          <div ref={previewScrollRef} onScroll={onPreviewScroll} className="flex-1 overflow-auto">
            {frontmatter.length > 0 && (
              <div className="border-b px-10 pt-7 pb-5">
                <button
                  type="button"
                  onClick={() => setShowMeta((v) => !v)}
                  className="flex w-full items-center gap-2 text-left"
                >
                  <ChevronDown
                    className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${
                      showMeta ? "" : "-rotate-90"
                    }`}
                  />
                  <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Frontmatter
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                    {frontmatter.length} field{frontmatter.length > 1 ? "s" : ""}
                  </span>
                </button>
                <div
                  className={`grid transition-all duration-200 ease-out ${
                    showMeta ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                  }`}
                >
                  <div className="overflow-hidden">
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-2.5 pt-4 text-sm">
                      {frontmatter.map(({ key, value }) => (
                        <Fragment key={key}>
                          <dt className="pt-0.5 font-mono text-xs uppercase tracking-wide text-muted-foreground">
                            {key}
                          </dt>
                          <dd className="min-w-0">{renderFrontValue(value)}</dd>
                        </Fragment>
                      ))}
                    </dl>
                  </div>
                </div>
              </div>
            )}
            <article
              ref={previewRef as any}
              className="markdown-body"
              data-color-mode={theme}
              data-light-theme="light"
              data-dark-theme="dark"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
