import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import {
  FileText, Plus, FolderOpen, Sun, Moon,
  ChevronDown, SlidersHorizontal, Lock, LockOpen, Globe, Save, TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { parseFrontmatter, type FrontmatterValue } from "@/lib/frontmatter";
import { renderMarkdown } from "@/lib/markdown";
import { createEditor, themeCompartment, themeExtensions, setMirror } from "@/lib/cm";
import type { ExternalDocumentChange } from "@/electron";
import {
  detachedDocument,
  isDocumentDirty,
  localDocument,
  newDocument,
  remoteDocument,
  welcomeDocument,
  type DocumentSession,
} from "@/lib/document-session";

const LS_THEME = "mdedit.theme.v2";
const LS_LOCK = "mdedit.lock.v1";
const LS_META = "mdedit.frontmatter.v1";

type Theme = "light" | "dark";
type Operation = { kind: "idle" | "saving" | "error" | "info"; message?: string };
type DiskConflict = { path: string; diskContent: string };
const WELCOME =
  "# Welcome\n\nA focused Markdown editor for one document at a time.\n\n- Open a local file and save changes directly to disk\n- Type on the left; see the GitHub-styled preview on the right\n- Drag the center handle to resize the panes\n- Lock scrolling or select text to mirror it across panes\n\n> New and remote documents remain copies until they are saved to disk.\n";
function initialTheme(): Theme {
  const s = localStorage.getItem(LS_THEME);
  if (s === "light" || s === "dark") return s;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function scalarText(value: string | number | boolean | null): string {
  if (value === null || value === "") return "—";
  return String(value);
}

function renderFrontValue(value: FrontmatterValue, depth = 0) {
  if (value === null) return <span className="text-muted-foreground/70">—</span>;
  if (typeof value !== "object") {
    if (value === "") return <span className="text-muted-foreground/70">—</span>;
    if (typeof value === "boolean") {
      return (
        <span className={`inline-flex rounded-[3px] border px-1.5 font-mono text-[10px] leading-4 ${value ? "border-brand/30 bg-brand/10 text-foreground" : "bg-muted/50 text-muted-foreground"}`}>
          {String(value)}
        </span>
      );
    }
    if (typeof value === "number") return <span className="font-mono text-[11px] tabular-nums">{value}</span>;
    if (value.includes("\n")) {
      return <span className="block whitespace-pre-wrap border-l border-border/70 pl-2 font-mono text-[11px] leading-4 text-foreground/85">{value.trimEnd()}</span>;
    }
    return <span className="break-words">{value}</span>;
  }

  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-muted-foreground/70">—</span>;
    const scalarItems = value.every((item) => item === null || typeof item !== "object");
    if (scalarItems) {
      const visible = value.slice(0, 18) as Array<string | number | boolean | null>;
      return (
        <div className="flex flex-wrap gap-1">
          {visible.map((item, index) => (
            <span key={index} className="rounded-[3px] border border-border/70 bg-background/50 px-1.5 font-mono text-[10px] leading-4 text-foreground/85">
              {scalarText(item)}
            </span>
          ))}
          {value.length > visible.length && <span className="font-mono text-[10px] leading-4 text-muted-foreground">+{value.length - visible.length}</span>}
        </div>
      );
    }
    return (
      <ol className="space-y-1 border-l border-border/70 pl-2.5">
        {value.slice(0, 12).map((item, index) => (
          <li key={index} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-1.5">
            <span className="pt-px font-mono text-[9px] leading-4 text-muted-foreground/65">{index + 1}</span>
            <div className="min-w-0">{renderFrontValue(item, depth + 1)}</div>
          </li>
        ))}
        {value.length > 12 && <li className="font-mono text-[10px] text-muted-foreground">+{value.length - 12} more</li>}
      </ol>
    );
  }

  const entries = Object.entries(value);
  if (!entries.length) return <span className="text-muted-foreground/70">&#123;&#125;</span>;
  return (
    <dl className={`grid grid-cols-[minmax(3.5rem,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1 ${depth > 0 ? "border-l border-border/70 pl-2.5" : ""}`}>
      {entries.slice(0, 20).map(([key, item]) => (
        <Fragment key={key}>
          <dt className="truncate font-mono text-[10px] leading-4 text-muted-foreground" title={key}>{key}</dt>
          <dd className="min-w-0 leading-4">{renderFrontValue(item, depth + 1)}</dd>
        </Fragment>
      ))}
      {entries.length > 20 && <dd className="col-span-2 font-mono text-[10px] text-muted-foreground">+{entries.length - 20} more fields</dd>}
    </dl>
  );
}

function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function collapse(s: string): string { return s.replace(/\s+/g, " ").trim(); }

// Marker-free, whitespace-collapsed text of a raw markdown fragment (a "needle").
function stripNorm(src: string): string {
  const s = src
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`~]/g, "")
    .replace(/(^|[^\w])_([^_]*)_(?=[^\w]|$)/g, "$1$2");
  return collapse(decodeEntities(s));
}

// Char-level stripped index of a source slice -> normalized text + map back to
// absolute document offsets (for mapping a preview selection to editor chars).
function strippedIndex(src: string, base: number): { norm: string; nmap: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  const lines = src.split("\n");
  let pos = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let lead = 0;
    while (lead < line.length && lead < 3 && line[lead] === " ") lead++;
    const mm = /^(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/.exec(line.slice(lead));
    const contentStart = lead + (mm ? mm[0].length : 0);
    for (let i = 0; i < line.length; i++) {
      if (i < contentStart) continue;
      const c = line[i];
      if (c === "*" || c === "`" || c === "~") continue;
      if (c === "_") {
        const p = i > 0 ? line[i - 1] : " ";
        const n = i + 1 < line.length ? line[i + 1] : " ";
        if (!/\w/.test(p) || !/\w/.test(n)) continue;
      }
      out.push(c); map.push(base + pos + i);
    }
    if (li < lines.length - 1) { out.push(" "); map.push(base + pos + line.length); }
    pos += line.length + 1;
  }
  let norm = "";
  const nmap: number[] = [];
  let prev = false;
  for (let k = 0; k < out.length; k++) {
    const c = out[k];
    if (/\s/.test(c)) { if (!prev) { norm += " "; nmap.push(map[k]); prev = true; } }
    else { norm += c; nmap.push(map[k]); prev = false; }
  }
  return { norm, nmap };
}

// Normalized text of a preview element + per-char (node, offset) for building ranges.
function buildDomIndex(root: HTMLElement): { norm: string; nodes: Node[]; offs: number[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let norm = "";
  const nodes: Node[] = [];
  const offs: number[] = [];
  let prev = false;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n.nodeValue || "";
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (/\s/.test(c)) { if (!prev) { norm += " "; nodes.push(n); offs.push(i); prev = true; } }
      else { norm += c; nodes.push(n); offs.push(i); prev = false; }
    }
  }
  return { norm, nodes, offs };
}

type Leaf = { el: HTMLElement; line: number };
function leafBlocks(art: HTMLElement, off: number): Leaf[] {
  const all = Array.from(art.querySelectorAll("[data-source-line]")) as HTMLElement[];
  return all
    .filter((el) => !el.querySelector("[data-source-line]"))
    .map((el) => ({ el, line: parseInt(el.getAttribute("data-source-line") || "0", 10) + off + 1 }))
    .sort((a, b) => a.line - b.line);
}
function intersecting(leaves: Leaf[], startLine: number, endLine: number): Leaf[] {
  const out: Leaf[] = [];
  for (let i = 0; i < leaves.length; i++) {
    const s = leaves[i].line;
    const e = i + 1 < leaves.length ? leaves[i + 1].line : Infinity;
    if (s <= endLine && e > startLine) out.push(leaves[i]);
  }
  return out;
}
function blockElOf(node: Node | null, art: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = node && node.nodeType === 3 ? node.parentElement : (node as HTMLElement | null);
  while (el && el !== art) {
    if (el.getAttribute && el.getAttribute("data-source-line") !== null) return el;
    el = el.parentElement;
  }
  return null;
}

export default function App() {
  const [session, setSession] = useState<DocumentSession>(() => welcomeDocument(WELCOME));
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [showMeta, setShowMeta] = useState(() => localStorage.getItem(LS_META) !== "0");
  const [locked, setLocked] = useState<boolean>(() => localStorage.getItem(LS_LOCK) === "1");
  const [dragActive, setDragActive] = useState(false);
  const [operation, setOperation] = useState<Operation>({ kind: "idle" });
  const [diskConflict, setDiskConflictState] = useState<DiskConflict | null>(null);
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlLoading, setUrlLoading] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(false);

  const cmParentRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const previewArticleRef = useRef<HTMLElement | null>(null);
  const anchorsRef = useRef<{ ey: number; py: number }[]>([]);
  const scrollSyncingRef = useRef(false);
  const programmaticRef = useRef(false);
  const dragDepth = useRef(0);
  const lastEditorMirrorRef = useRef<string>("");
  const mirrorHlRef = useRef<any>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const recoveryStartedRef = useRef(false);
  const skipInitialRecoverySyncRef = useRef(true);
  const recoveryErrorRef = useRef<string | null>(null);
  const diskConflictRef = useRef<DiskConflict | null>(null);
  const externalChangeRef = useRef<(change: ExternalDocumentChange) => void>(() => {});
  const infoTimerRef = useRef<number | null>(null);

  const content = session.content;
  const dirty = isDocumentDirty(session);
  const frontmatterResult = useMemo(() => parseFrontmatter(content), [content]);
  const { entries: frontmatter, body, offsetLines } = frontmatterResult;
  const html = useMemo(() => renderMarkdown(body), [body]);
  const htmlObj = useMemo(() => ({ __html: html }), [html]);

  // latest values for stable CM callbacks
  const contentRef = useRef(content); contentRef.current = content;
  const documentRef = useRef(session); documentRef.current = session;
  const offsetRef = useRef(offsetLines); offsetRef.current = offsetLines;
  const lockedRef = useRef(locked); lockedRef.current = locked;
  const setCurrentSession = useCallback((next: DocumentSession) => {
    documentRef.current = next;
    setSession(next);
    window.desktopDocuments.setCloseState({
      dirty: isDocumentDirty(next),
      title: next.title,
    });
  }, []);
  const setDiskConflict = useCallback((next: DiskConflict | null) => {
    diskConflictRef.current = next;
    setDiskConflictState(next);
  }, []);

  // ---- preview mirror (editor selection -> exact text highlight in preview) ----
  const clearPreviewMirror = useCallback(() => { mirrorHlRef.current?.clear?.(); }, []);

  // ---- editor mirror (preview selection -> highlight editor lines) ----
  const setEditorMirror = useCallback((from: number, to: number) => {
    const view = viewRef.current;
    if (!view) return;
    const key = from + ":" + to;
    if (lastEditorMirrorRef.current === key) return;
    lastEditorMirrorRef.current = key;
    view.dispatch({ effects: setMirror.of({ from, to }) });
  }, []);
  const clearEditorMirror = useCallback(() => {
    const view = viewRef.current;
    if (!view || lastEditorMirrorRef.current === "") return;
    lastEditorMirrorRef.current = "";
    view.dispatch({ effects: setMirror.of(null) });
  }, []);

  // ---- scroll anchors (source-line based) ----
  const recomputeAnchors = useCallback(() => {
    const view = viewRef.current;
    const pscroll = previewScrollRef.current;
    const art = previewArticleRef.current;
    if (!view || !pscroll || !art) { anchorsRef.current = []; return; }
    const off = offsetRef.current;
    const doc = view.state.doc;
    const cTop = pscroll.getBoundingClientRect().top;
    // Pin BOTH the top and bottom of every leaf block so alignment stays tight
    // through tall blocks (a top-only pin drifts mid-block since the two sides
    // have different line heights).
    const leaves = leafBlocks(art, off);
    const list: { ey: number; py: number }[] = [{ ey: 0, py: 0 }];
    for (let i = 0; i < leaves.length; i++) {
      const el = leaves[i].el;
      const docLine = Math.max(1, Math.min(leaves[i].line, doc.lines));
      const endLine = Math.max(docLine, Math.min(i + 1 < leaves.length ? leaves[i + 1].line - 1 : doc.lines, doc.lines));
      const rect = el.getBoundingClientRect();
      try {
        const top = view.lineBlockAt(doc.line(docLine).from).top;
        list.push({ ey: top, py: rect.top - cTop + pscroll.scrollTop });
        const bottom = view.lineBlockAt(doc.line(endLine).from).bottom;
        list.push({ ey: bottom, py: rect.bottom - cTop + pscroll.scrollTop });
      } catch { /* skip */ }
    }
    list.push({
      ey: Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight),
      py: Math.max(0, pscroll.scrollHeight - pscroll.clientHeight),
    });
    list.sort((a, b) => a.ey - b.ey);
    const dedup: { ey: number; py: number }[] = [];
    for (const p of list) {
      if (dedup.length && Math.abs(dedup[dedup.length - 1].ey - p.ey) < 0.5) {
        if (p.py > dedup[dedup.length - 1].py) dedup[dedup.length - 1].py = p.py;
        continue;
      }
      dedup.push(p);
    }
    for (let i = 1; i < dedup.length; i++) if (dedup[i].py < dedup[i - 1].py) dedup[i].py = dedup[i - 1].py;
    anchorsRef.current = dedup;
  }, []);
  function interp(val: number, fromKey: "ey" | "py", toKey: "ey" | "py"): number | null {
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
  const onEditorScroll = useCallback(() => {
    if (!lockedRef.current || scrollSyncingRef.current) return;
    const view = viewRef.current, pscroll = previewScrollRef.current;
    if (!view || !pscroll) return;
    if (!anchorsRef.current.length) recomputeAnchors();
    const target = interp(view.scrollDOM.scrollTop, "ey", "py");
    if (target == null) return;
    scrollSyncingRef.current = true;
    pscroll.scrollTop = target;
    requestAnimationFrame(() => { scrollSyncingRef.current = false; });
  }, [recomputeAnchors]);
  function onPreviewScroll() {
    if (!lockedRef.current || scrollSyncingRef.current) return;
    const view = viewRef.current, pscroll = previewScrollRef.current;
    if (!view || !pscroll) return;
    if (!anchorsRef.current.length) recomputeAnchors();
    const target = interp(pscroll.scrollTop, "py", "ey");
    if (target == null) return;
    scrollSyncingRef.current = true;
    view.scrollDOM.scrollTop = target;
    requestAnimationFrame(() => { scrollSyncingRef.current = false; });
  }

  // stable refs to latest handlers for the CM listeners created once
  const onDocChange = useCallback((doc: string) => {
    if (programmaticRef.current) return;
    setCurrentSession({ ...documentRef.current, content: doc });
  }, [setCurrentSession]);
  const onSelection = useCallback((from: number, to: number, empty: boolean) => {
    if (programmaticRef.current) return;
    const hl = mirrorHlRef.current;
    const view = viewRef.current;
    const art = previewArticleRef.current;
    if (!hl || !view || !art) return;
    hl.clear();
    clearEditorMirror(); // editor is the source now; drop any incoming mirror mark
    if (empty) return;
    const off = offsetRef.current;
    const startDocLine = view.state.doc.lineAt(from).number;
    const endDocLine = view.state.doc.lineAt(to).number;
    const leaves = leafBlocks(art, off);
    const hit = intersecting(leaves, startDocLine, endDocLine);
    if (!hit.length) return;
    try {
      if (hit.length === 1) {
        const el = hit[0].el;
        const needle = stripNorm(view.state.doc.sliceString(from, to));
        const di = buildDomIndex(el);
        const idx = needle.length >= 2 ? di.norm.indexOf(needle) : -1;
        if (idx >= 0) {
          const end = idx + needle.length - 1;
          const r = document.createRange();
          r.setStart(di.nodes[idx], di.offs[idx]);
          r.setEnd(di.nodes[end], di.offs[end] + 1);
          hl.add(r);
          return;
        }
        const r = document.createRange();
        r.selectNodeContents(el);
        hl.add(r);
        return;
      }
      const r = document.createRange();
      r.setStartBefore(hit[0].el);
      r.setEndAfter(hit[hit.length - 1].el);
      hl.add(r);
    } catch { /* stale nodes */ }
  }, [clearEditorMirror]);
  const docChangeRef = useRef(onDocChange); docChangeRef.current = onDocChange;
  const selectionRef = useRef(onSelection); selectionRef.current = onSelection;
  const scrollRef = useRef(onEditorScroll); scrollRef.current = onEditorScroll;

  // ---- create CodeMirror once ----
  useEffect(() => {
    if (!cmParentRef.current) return;
    const view = createEditor({
      parent: cmParentRef.current,
      doc: contentRef.current,
      dark: theme === "dark",
      onDocChange: (d) => docChangeRef.current(d),
      onSelection: (f, t, e) => selectionRef.current(f, t, e),
      onScroll: () => scrollRef.current(),
    });
    viewRef.current = view;
    (window as any).__mdView = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setEditorDoc(text: string) {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === text) return;
    programmaticRef.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    programmaticRef.current = false;
  }

  function replaceDocument(next: DocumentSession) {
    setEditorDoc(next.content);
    setCurrentSession(next);
    setDiskConflict(null);
    setOperation({ kind: "idle" });
    clearPreviewMirror();
    clearEditorMirror();
    requestAnimationFrame(() => requestAnimationFrame(() => recomputeAnchors()));
  }

  function showInfo(message: string) {
    if (infoTimerRef.current !== null) window.clearTimeout(infoTimerRef.current);
    setOperation({ kind: "info", message });
    infoTimerRef.current = window.setTimeout(() => {
      setOperation((current) => current.kind === "info" && current.message === message ? { kind: "idle" } : current);
      infoTimerRef.current = null;
    }, 2200);
  }

  function reloadLocalDocument(current: DocumentSession, diskContent: string) {
    if (current.source.kind !== "local") return;
    const view = viewRef.current;
    const selection = view?.state.selection.main;
    const editorScrollTop = view?.scrollDOM.scrollTop;
    const previewScrollTop = previewScrollRef.current?.scrollTop;
    setEditorDoc(diskContent);
    if (view && selection) {
      const documentLength = view.state.doc.length;
      programmaticRef.current = true;
      view.dispatch({ selection: {
        anchor: Math.min(selection.anchor, documentLength),
        head: Math.min(selection.head, documentLength),
      } });
      programmaticRef.current = false;
    }
    setCurrentSession(localDocument(current.source.path, current.title, diskContent));
    setDiskConflict(null);
    clearPreviewMirror();
    clearEditorMirror();
    showInfo("Reloaded from disk");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      scrollSyncingRef.current = true;
      if (view && editorScrollTop !== undefined) view.scrollDOM.scrollTop = editorScrollTop;
      if (previewScrollRef.current && previewScrollTop !== undefined) previewScrollRef.current.scrollTop = previewScrollTop;
      recomputeAnchors();
      requestAnimationFrame(() => { scrollSyncingRef.current = false; });
    }));
  }

  function handleExternalChange(change: ExternalDocumentChange) {
    if (change.status === "error") {
      setOperation({ kind: "error", message: change.message });
      return;
    }
    const current = documentRef.current;
    if (current.source.kind !== "local" || current.source.path !== change.path) return;
    if (change.status === "missing") {
      setCurrentSession(detachedDocument(current));
      setDiskConflict(null);
      showInfo("File removed — save a copy");
      return;
    }
    if (change.content === current.content) {
      setCurrentSession({ ...current, savedContent: change.content });
      setDiskConflict(null);
      showInfo("Matched disk");
      return;
    }
    if (change.content === current.savedContent) {
      setDiskConflict(null);
      showInfo("Disk change reverted");
      return;
    }
    if (isDocumentDirty(current)) {
      setDiskConflict({ path: change.path, diskContent: change.content });
      return;
    }
    reloadLocalDocument(current, change.content);
  }
  externalChangeRef.current = handleExternalChange;

  // theme
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.setAttribute("data-color-mode", theme);
    root.setAttribute("data-light-theme", "light");
    root.setAttribute("data-dark-theme", "dark");
    localStorage.setItem(LS_THEME, theme);
    viewRef.current?.dispatch({ effects: themeCompartment.reconfigure(themeExtensions(theme === "dark")) });
  }, [theme]);

  useEffect(() => { localStorage.setItem(LS_LOCK, locked ? "1" : "0"); if (locked) recomputeAnchors(); }, [locked, recomputeAnchors]);
  useEffect(() => { localStorage.setItem(LS_META, showMeta ? "1" : "0"); }, [showMeta]);
  useEffect(() => {
    if (recoveryStartedRef.current) return;
    recoveryStartedRef.current = true;
    const desktop = window.desktopDocuments;
    void (async () => {
      const recovery = await desktop.restoreRecovery();
      if (recovery.status === "restored") replaceDocument(recovery.document);
      else if (recovery.status === "none") {
        const previous = await desktop.restorePreviousDocument();
        if (previous.status === "restored") replaceDocument(previous.document);
        if (previous.status === "error") setOperation({ kind: "error", message: previous.message });
      } else {
        recoveryErrorRef.current = recovery.message;
        setOperation({ kind: "error", message: recovery.message });
      }
      setRecoveryReady(true);
    })();
  }, []);
  useEffect(() => {
    if (!recoveryReady) return;
    void window.desktopDocuments.rememberDocument(session).then((result) => {
      if (result.status === "error") setOperation({ kind: "error", message: result.message });
    });
  }, [recoveryReady, session.source, session.title, session.savedContent]);
  useEffect(() => {
    if (!recoveryReady) return;
    if (skipInitialRecoverySyncRef.current) {
      skipInitialRecoverySyncRef.current = false;
      return;
    }
    const desktop = window.desktopDocuments;
    const snapshot = session;
    const delay = snapshot.source.kind !== "detached" && isDocumentDirty(snapshot) ? 350 : 0;
    const timer = window.setTimeout(() => {
      void desktop.updateRecovery(snapshot).then((result) => {
        if (result.status === "error") {
          if (recoveryErrorRef.current === result.message) return;
          recoveryErrorRef.current = result.message;
          setOperation({ kind: "error", message: result.message });
          return;
        }
        const previousError = recoveryErrorRef.current;
        if (!previousError) return;
        recoveryErrorRef.current = null;
        setOperation((current) => current.kind === "error" && current.message === previousError ? { kind: "idle" } : current);
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [recoveryReady, session]);
  const localPath = session.source.kind === "local" ? session.source.path : null;
  useEffect(() => {
    return window.desktopDocuments.onExternalChange((change) => externalChangeRef.current(change));
  }, []);
  useEffect(() => {
    const desktop = window.desktopDocuments;
    if (localPath) desktop.watchLocal({ path: localPath, content: session.savedContent });
    else desktop.stopWatching();
  }, [localPath, session.savedContent]);
  useEffect(() => {
    if (dirty || !diskConflict) return;
    const current = documentRef.current;
    if (current.source.kind !== "local" || current.source.path !== diskConflict.path) return;
    reloadLocalDocument(current, diskConflict.diskContent);
  }, [dirty, diskConflict]);
  useEffect(() => () => {
    if (infoTimerRef.current !== null) window.clearTimeout(infoTimerRef.current);
    window.desktopDocuments.stopWatching();
  }, []);
  useEffect(() => {
    window.desktopDocuments.setCloseState({
      dirty,
      title: session.title,
    });
    window.document.title = `${session.title} — Markdown Editor`;
  }, [dirty, session.source.kind, session.title]);

  // register a CSS Custom Highlight for exact preview-side mirror ranges
  useEffect(() => {
    const g = window as any;
    if (!g.Highlight || !(CSS as any).highlights) return;
    const hl = new g.Highlight();
    (CSS as any).highlights.set("md-mirror", hl);
    mirrorHlRef.current = hl;
    return () => { (CSS as any).highlights.delete("md-mirror"); mirrorHlRef.current = null; };
  }, []);

  // recompute anchors after render / on resize
  useEffect(() => {
    mirrorHlRef.current?.clear?.();
    const id = requestAnimationFrame(() => requestAnimationFrame(() => recomputeAnchors()));
    return () => cancelAnimationFrame(id);
  }, [html, recomputeAnchors]);
  useEffect(() => {
    const ro = new ResizeObserver(() => recomputeAnchors());
    if (previewScrollRef.current) ro.observe(previewScrollRef.current);
    if (viewRef.current) ro.observe(viewRef.current.scrollDOM);
    return () => ro.disconnect();
  }, [recomputeAnchors]);

  useEffect(() => {
    function srcRange(el: HTMLElement, leaves: Leaf[], doc: any): { from: number; to: number } {
      const dl = Math.max(1, Math.min(parseInt(el.getAttribute("data-source-line") || "0", 10) + offsetRef.current + 1, doc.lines));
      const idx = leaves.findIndex((L) => L.el === el);
      const nextLine = idx >= 0 && idx + 1 < leaves.length ? leaves[idx + 1].line : doc.lines + 1;
      const toLine = Math.max(dl, Math.min(nextLine - 1, doc.lines));
      return { from: doc.line(dl).from, to: doc.line(toLine).to };
    }
    function onSel() {
      const sel = window.getSelection();
      const art = previewArticleRef.current;
      const view = viewRef.current;
      if (!(sel && !sel.isCollapsed && art && sel.anchorNode && art.contains(sel.anchorNode)) || !view) {
        clearEditorMirror();
        return;
      }
      const rg = sel.getRangeAt(0);
      // preview is the source now: drop the preview's own mirror and collapse the
      // editor's drawn selection so the two sides never show competing highlights.
      clearPreviewMirror();
      if (!view.state.selection.main.empty) {
        programmaticRef.current = true;
        view.dispatch({ selection: { anchor: view.state.selection.main.head } });
        programmaticRef.current = false;
      }
      const startEl = blockElOf(rg.startContainer, art);
      const endEl = blockElOf(rg.endContainer, art);
      if (!startEl) { clearEditorMirror(); return; }
      const doc = view.state.doc;
      const leaves = leafBlocks(art, offsetRef.current);
      if (startEl === endEl) {
        const { from, to } = srcRange(startEl, leaves, doc);
        const needle = collapse(sel.toString());
        if (needle.length >= 2) {
          const { norm, nmap } = strippedIndex(doc.sliceString(from, to), from);
          const idx = norm.indexOf(needle);
          if (idx >= 0) { setEditorMirror(nmap[idx], nmap[idx + needle.length - 1] + 1); return; }
        }
        setEditorMirror(from, to);
        return;
      }
      const a = srcRange(startEl, leaves, doc);
      const b = srcRange(endEl, leaves, doc);
      setEditorMirror(Math.min(a.from, b.from), Math.max(a.to, b.to));
    }
    let raf = 0;
    const schedule = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; onSel(); }); };
    document.addEventListener("selectionchange", schedule);
    return () => { document.removeEventListener("selectionchange", schedule); if (raf) cancelAnimationFrame(raf); };
  }, [setEditorMirror, clearEditorMirror, clearPreviewMirror]);

  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => { window.removeEventListener("dragover", prevent); window.removeEventListener("drop", prevent); };
  }, []);
  useEffect(() => {
    return window.desktopDocuments.onSaveBeforeClose(() => {
      void saveCurrentDocument().then((saved) => window.desktopDocuments.finishCloseSave(saved));
    });
  }, []);
  useEffect(() => window.desktopDocuments.onMenuCommand((command) => {
    if (command === "new") void newFile();
    else if (command === "open") void openLocalDocument();
    else if (command === "open-url") setUrlOpen(true);
    else if (command === "save") void saveCurrentDocument();
    else if (command === "save-as") void saveDocumentAs();
  }), []);
  useEffect(() => {
    if (!urlOpen) return;
    setUrlError(null);
    const t = window.setTimeout(() => urlInputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [urlOpen]);

  // ---- file ops ----
  async function saveLocalDocument(resolvesConflict = false): Promise<boolean> {
    const desktop = window.desktopDocuments;
    const snapshot = documentRef.current;
    if (snapshot.source.kind !== "local") return false;
    const filePath = snapshot.source.path;
    const contentToSave = snapshot.content;
    setOperation({ kind: "saving" });
    const result = await desktop.save({ path: filePath, content: contentToSave });
    if (result.status === "error") {
      setOperation({ kind: "error", message: result.message });
      return false;
    }
    desktop.watchLocal({ path: filePath, content: contentToSave });
    const current = documentRef.current;
    if (current.source.kind === "local" && current.source.path === filePath) {
      const saved = { ...current, savedContent: contentToSave };
      setCurrentSession(saved);
      if (resolvesConflict) setDiskConflict(null);
      const recovery = await desktop.updateRecovery(saved);
      if (recovery.status === "error") {
        recoveryErrorRef.current = recovery.message;
        setOperation({ kind: "error", message: recovery.message });
        return true;
      }
      recoveryErrorRef.current = null;
    }
    setOperation({ kind: "idle" });
    return true;
  }

  async function saveDocumentAs(): Promise<boolean> {
    const desktop = window.desktopDocuments;
    const snapshot = documentRef.current;
    setOperation({ kind: "saving" });
    const result = await desktop.saveAs({ title: snapshot.title, content: snapshot.content });
    if (result.status === "cancelled") {
      setOperation({ kind: "idle" });
      return false;
    }
    if (result.status === "error") {
      setOperation({ kind: "error", message: result.message });
      return false;
    }
    const current = documentRef.current;
    const saved = localDocument(result.document.path, result.document.name, snapshot.content);
    const next = current === snapshot ? saved : { ...saved, content: current.content };
    setCurrentSession(next);
    setDiskConflict(null);
    const recovery = await desktop.updateRecovery(next);
    if (recovery.status === "error") {
      recoveryErrorRef.current = recovery.message;
      setOperation({ kind: "error", message: recovery.message });
      return true;
    }
    recoveryErrorRef.current = null;
    setOperation({ kind: "idle" });
    return true;
  }

  async function resolveDiskConflict(conflict: DiskConflict): Promise<boolean> {
    const desktop = window.desktopDocuments;
    const current = documentRef.current;
    if (current.source.kind !== "local" || current.source.path !== conflict.path) return false;
    const choice = await desktop.confirmExternalChange({ title: current.title });
    if (choice === "save-copy") return saveDocumentAs();
    if (choice === "overwrite") return saveLocalDocument(true);
    if (choice === "reload") {
      reloadLocalDocument(current, conflict.diskContent);
      return true;
    }
    return false;
  }

  async function saveCurrentDocument(): Promise<boolean> {
    const current = documentRef.current;
    if (current.source.kind !== "local") return saveDocumentAs();
    const conflict = diskConflictRef.current;
    return conflict?.path === current.source.path ? resolveDiskConflict(conflict) : saveLocalDocument();
  }

  async function canReplaceDocument(): Promise<boolean> {
    const current = documentRef.current;
    if (!isDocumentDirty(current)) return true;
    const desktop = window.desktopDocuments;
    const choice = await desktop.confirmUnsaved({ title: current.title });
    if (choice === "cancel") return false;
    if (choice === "save") return saveCurrentDocument();
    return true;
  }

  async function openLocalDocument() {
    const desktop = window.desktopDocuments;
    const result = await desktop.open();
    if (result.status === "cancelled") return;
    if (result.status === "error") {
      setOperation({ kind: "error", message: result.message });
      return;
    }
    if (!(await canReplaceDocument())) return;
    const opened = result.document;
    replaceDocument(localDocument(opened.path, opened.name, opened.content));
  }

  async function newFile() {
    if (!(await canReplaceDocument())) return;
    replaceDocument(newDocument());
  }

  async function openFromUrl() {
    const desktop = window.desktopDocuments;
    if (!(await canReplaceDocument())) return;
    setUrlLoading(true); setUrlError(null);
    const result = await desktop.openRemote(urlValue);
    setUrlLoading(false);
    if (result.status === "error") { setUrlError(result.message); return; }
    const opened = result.document;
    replaceDocument(remoteDocument(opened.url, opened.name, opened.content));
    setUrlOpen(false); setUrlValue("");
  }

  // ---- drag & drop ----
  function dragHasFiles(e: React.DragEvent) { return Array.from(e.dataTransfer?.types ?? []).includes("Files"); }
  function onDragEnter(e: React.DragEvent) { if (!dragHasFiles(e)) return; e.preventDefault(); dragDepth.current += 1; setDragActive(true); }
  function onDragOver(e: React.DragEvent) { if (!dragHasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
  function onDragLeave(e: React.DragEvent) { if (!dragHasFiles(e)) return; e.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragActive(false); }
  function onDrop(e: React.DragEvent) {
    e.preventDefault(); dragDepth.current = 0; setDragActive(false);
    const file = Array.from(e.dataTransfer.files).find((candidate) =>
      /\.(md|markdown|mdx|txt)$/i.test(candidate.name) || candidate.type === "text/markdown" || candidate.type === "text/plain"
    );
    if (!file) return;
    const desktop = window.desktopDocuments;
    void (async () => {
      if (!(await canReplaceDocument())) return;
      const result = await desktop.openDroppedFile(file);
      if (result.status === "opened") {
        const opened = result.document;
        replaceDocument(localDocument(opened.path, opened.name, opened.content));
      } else if (result.status === "error") {
        setOperation({ kind: "error", message: result.message });
      }
    })();
  }

  return (
    <div
      className="relative flex h-full flex-col bg-background text-foreground"
      onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-brand px-10 py-8 text-center">
            <FolderOpen className="h-8 w-8 text-brand" />
            <div className="text-base font-semibold">Drop a Markdown file to open</div>
            <div className="text-xs text-muted-foreground">.md .markdown .mdx .txt</div>
          </div>
        </div>
      )}

      {urlOpen && (
        <div className="absolute inset-0 z-50 flex items-start justify-center bg-background/70 pt-[18vh] backdrop-blur-sm"
          onClick={() => { if (!urlLoading) setUrlOpen(false); }}>
          <div className="w-[min(560px,90vw)] rounded-xl border bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Globe className="h-4 w-4 text-brand" /> Open a remote Markdown file
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Paste a raw URL or a GitHub file link (github.com/owner/repo/blob/branch/file.md).
            </div>
            <Input ref={urlInputRef} value={urlValue}
              placeholder="https://raw.githubusercontent.com/owner/repo/main/README.md"
              className="mt-3"
              onChange={(e) => { setUrlValue(e.target.value); if (urlError) setUrlError(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); if (!urlLoading) void openFromUrl(); }
                else if (e.key === "Escape") { e.preventDefault(); setUrlOpen(false); }
              }} />
            {urlError && <div className="mt-2 text-xs text-destructive">{urlError}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setUrlOpen(false)} disabled={urlLoading}>Cancel</Button>
              <Button onClick={() => void openFromUrl()} disabled={urlLoading || !urlValue.trim()}>
                {urlLoading ? "Opening…" : "Open"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <header className="flex flex-none items-center gap-2 border-b bg-card px-4 py-2.5">
        <div className="flex shrink-0 select-none items-center gap-2 pr-1 font-semibold tracking-tight">
          <span className="h-3.5 w-3.5 rotate-45 rounded-[4px] bg-gradient-to-br from-brand via-[#579fb5] to-muted-foreground shadow-sm" />
          Markdown
        </div>
        <Separator orientation="vertical" className="mx-1 h-6" />

        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-transparent px-2 py-1.5">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium" title={session.title}>{session.title}</span>
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${dirty ? "bg-[#e79d26]" : "bg-transparent"}`}
          />
        </div>

        <Button variant="outline" aria-label="New document" className="px-2.5 lg:px-4" onClick={() => void newFile()}>
          <Plus /><span className="hidden lg:inline">New</span>
        </Button>
        <Button variant="outline" aria-label="Open document" className="px-2.5 lg:px-4" onClick={() => void openLocalDocument()}>
          <FolderOpen /><span className="hidden lg:inline">Open</span>
        </Button>
        <Button variant="outline" aria-label="Open document from URL" className="px-2.5 lg:px-4" onClick={() => setUrlOpen(true)}>
          <Globe /><span className="hidden lg:inline">Open URL</span>
        </Button>
        <Button onClick={() => void saveCurrentDocument()} disabled={session.source.kind === "local" && !dirty}>
          <Save /> Save
        </Button>

        <Separator orientation="vertical" className="mx-1 h-6" />
        <Button variant="outline" size="icon" aria-pressed={locked}
          aria-label={locked ? "Unlock scrolling between panes" : "Lock scrolling between panes"}
          title={locked ? "Scroll locked — click to unlock" : "Lock scroll between panes"}
          onClick={() => setLocked((v) => !v)} className={locked ? "border-brand bg-brand/15 text-foreground" : ""}>
          {locked ? <Lock /> : <LockOpen />}
        </Button>
        <Button variant="outline" size="icon" aria-label="Toggle color theme" title="Toggle theme" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>
          {theme === "dark" ? <Sun /> : <Moon />}
        </Button>

        <div className={`hidden w-[100px] shrink-0 items-center gap-2 whitespace-nowrap text-xs md:flex ${operation.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}
          role="status" title={operation.message || (diskConflict ? "This document also changed on disk." : undefined)}>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${operation.kind === "error" ? "bg-destructive" : operation.kind === "saving" || diskConflict || dirty ? "bg-[#e79d26]" : "bg-brand"}`} />
          <span className="truncate">
            {operation.kind === "error"
              ? operation.message
              : operation.kind === "saving"
                ? "Saving…"
                : diskConflict
                  ? "Disk changed"
                  : operation.kind === "info"
                    ? operation.message
                    : session.source.kind === "detached"
                      ? "File missing"
                      : dirty
                        ? "Edited"
                        : session.source.kind === "local"
                          ? "Saved to disk"
                          : session.source.kind === "remote"
                            ? "Remote copy"
                            : "Not saved to disk"}
          </span>
        </div>
      </header>

      <ResizablePanelGroup direction="horizontal" autoSaveId="mdedit-split" className="flex-1">
        <ResizablePanel defaultSize={50} minSize={20} className="flex flex-col">
          <div className="flex h-[34px] flex-none items-center gap-2 border-b bg-card px-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
            RAW <span className="opacity-40">·</span> markdown
          </div>
          <div ref={cmParentRef} className="min-h-0 flex-1 overflow-hidden" />
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={50} minSize={20} className="flex flex-col">
          <div className="flex h-[34px] flex-none items-center gap-2 border-b bg-card px-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
            PREVIEW <span className="opacity-40">·</span> github <span className="text-brand">●</span>
          </div>
          <div ref={previewScrollRef} onScroll={onPreviewScroll} className="flex-1 overflow-auto">
            {frontmatterResult.status === "error" && (
              <div className="border-b border-destructive/20 bg-destructive/[0.035] px-8 py-2.5">
                <div className="flex items-center gap-2">
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />
                  <span className="text-[11px] font-semibold text-foreground/90">Frontmatter error</span>
                  <span className="ml-auto font-mono text-[9.5px] tabular-nums text-destructive/80">
                    L{frontmatterResult.error.line}:{frontmatterResult.error.column}
                  </span>
                </div>
                <p className="mt-1 break-words pl-[22px] text-[11px] leading-4 text-muted-foreground">
                  {frontmatterResult.error.message} The source remains visible below.
                </p>
              </div>
            )}
            {frontmatterResult.status === "parsed" && frontmatter.length > 0 && (
              <div className="border-b bg-muted/[0.14] px-8 py-2">
                <button type="button" aria-expanded={showMeta} onClick={() => setShowMeta((v) => !v)} className="flex min-h-5 w-full items-center gap-1.5 text-left">
                  <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform duration-150 ${showMeta ? "" : "-rotate-90"}`} />
                  <SlidersHorizontal className="h-3 w-3 text-muted-foreground/80" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Frontmatter</span>
                  <span className="ml-auto rounded-[3px] bg-muted/70 px-1.5 font-mono text-[9.5px] leading-4 text-muted-foreground">
                    {frontmatter.length} field{frontmatter.length === 1 ? "" : "s"}
                  </span>
                </button>
                <div className={`grid transition-all duration-150 ease-out ${showMeta ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
                  <div className="overflow-hidden">
                    <dl className="grid grid-cols-[minmax(5rem,0.32fr)_minmax(0,1fr)] gap-x-4 gap-y-1.5 pt-2 pb-0.5 text-[12px] leading-4">
                      {frontmatter.map(({ key, value }) => (
                        <Fragment key={key}>
                          <dt className="truncate pt-px font-mono text-[10px] leading-4 text-muted-foreground" title={key}>{key}</dt>
                          <dd className="min-w-0 text-foreground/90">{renderFrontValue(value)}</dd>
                        </Fragment>
                      ))}
                    </dl>
                  </div>
                </div>
              </div>
            )}
            <article ref={previewArticleRef as any} className="markdown-body"
              data-color-mode={theme} data-light-theme="light" data-dark-theme="dark"
              dangerouslySetInnerHTML={htmlObj} />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
