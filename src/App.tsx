import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  FileText, Plus, Upload, Download, Trash2, Sun, Moon, Pencil, Check,
  ChevronDown, ChevronRight, SlidersHorizontal,
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
          <Textarea
            id="md-raw"
            value={content}
            spellCheck={false}
            onChange={(e) => onContentChange(e.target.value)}
            onKeyDown={onEditorKeyDown}
            placeholder="# Start typing markdown..."
            className="h-full flex-1 resize-none overflow-auto whitespace-pre rounded-none p-6 font-mono text-[13.5px] leading-[1.75] caret-[hsl(var(--brand))] focus-visible:ring-0"
            style={{ tabSize: 2 }}
          />
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={50} minSize={20} className="flex flex-col">
          <div className="flex h-[34px] flex-none items-center gap-2 border-b bg-card px-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
            PREVIEW <span className="opacity-40">·</span> github <span className="text-brand">●</span>
          </div>
          <div className="flex-1 overflow-auto">
            {frontmatter.length > 0 && (
              <div className="mx-auto max-w-[980px] px-6 pt-5">
                <div className="rounded-lg border bg-card">
                  <button
                    type="button"
                    onClick={() => setShowMeta((v) => !v)}
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-secondary/60"
                  >
                    {showMeta ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Frontmatter
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {frontmatter.length} field{frontmatter.length > 1 ? "s" : ""}
                    </span>
                  </button>
                  {showMeta && (
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-2 border-t px-4 py-3 text-sm">
                      {frontmatter.map(({ key, value }) => (
                        <Fragment key={key}>
                          <dt className="pt-0.5 font-mono text-xs uppercase tracking-wide text-muted-foreground">
                            {key}
                          </dt>
                          <dd className="min-w-0">{renderFrontValue(value)}</dd>
                        </Fragment>
                      ))}
                    </dl>
                  )}
                </div>
              </div>
            )}
            <article
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
