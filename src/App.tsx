import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import {
  FileText, Plus, Upload, Download, Trash2, Sun, Moon, Pencil, Check,
  ChevronDown, SlidersHorizontal, Lock, LockOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { parseFrontmatter, renderMarkdown, type FrontValue } from "@/lib/markdown";
import { createEditor, themeCompartment, themeExtensions, setMirror } from "@/lib/cm";

const LS_FILES = "mdedit.files.v2";
const LS_ACTIVE = "mdedit.activeId.v2";
const LS_THEME = "mdedit.theme.v2";
const LS_LOCK = "mdedit.lock.v1";
const AUTOSAVE_DEBOUNCE = 800;
const AUTOSAVE_INTERVAL = 15000;

type MdFile = { id: string; title: string; content: string; updated: number };
type Theme = "light" | "dark";

function uid() {
  return "f_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}
const WELCOME =
  "# Welcome\n\nA **live markdown editor** built with CodeMirror + markdown-it.\n\n- Type on the left; see the _GitHub-styled_ render on the right\n- Drag the center handle to resize\n- Toggle light / dark, and lock the two scrolls together\n- Select on either side to mirror the matching block\n- Content **autosaves**; drop `.md` files to open them\n\n```ts\nconsole.log('everything persists to localStorage');\n```\n\n> Multiple files, one at a time. Use the dropdown up top.\n";

function loadFiles(): MdFile[] {
  try {
    const raw = localStorage.getItem(LS_FILES);
    const parsed = raw ? (JSON.parse(raw) as MdFile[]) : [];
    if (parsed.length) return parsed;
  } catch { /* ignore */ }
  return [{ id: uid(), title: "Welcome", content: WELCOME, updated: Date.now() }];
}
function initialTheme(): Theme {
  const s = localStorage.getItem(LS_THEME);
  if (s === "light" || s === "dark") return s;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function renderFrontValue(value: FrontValue) {
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-muted-foreground">-</span>;
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.map((item, i) => (
          <span key={i} className="rounded-full border px-2 py-0.5 text-xs">{item}</span>
        ))}
      </div>
    );
  }
  if (typeof value === "boolean")
    return (
      <span className={"inline-block rounded-full px-2 py-0.5 text-xs font-medium " + (value ? "bg-brand/20 text-foreground" : "bg-secondary text-muted-foreground")}>
        {value ? "true" : "false"}
      </span>
    );
  if (!value) return <span className="text-muted-foreground">-</span>;
  return <span className="break-words">{value}</span>;
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
  const boot = useRef(
    (() => {
      const list = loadFiles();
      localStorage.setItem(LS_FILES, JSON.stringify(list));
      const stored = localStorage.getItem(LS_ACTIVE);
      const id = list.some((f) => f.id === stored) ? (stored as string) : list[0].id;
      return { list, id };
    })()
  );
  const [files, setFiles] = useState<MdFile[]>(boot.current.list);
  const [activeId, setActiveId] = useState<string>(boot.current.id);
  const [content, setContent] = useState<string>(() => boot.current.list.find((f) => f.id === boot.current.id)!.content);
  const [title, setTitle] = useState<string>(() => boot.current.list.find((f) => f.id === boot.current.id)!.title);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [showMeta, setShowMeta] = useState(true);
  const [locked, setLocked] = useState<boolean>(() => localStorage.getItem(LS_LOCK) === "1");
  const [dragActive, setDragActive] = useState(false);
  const [status, setStatus] = useState<{ kind: "saved" | "saving"; at?: string }>({ kind: "saved" });

  const cmParentRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const previewArticleRef = useRef<HTMLElement | null>(null);
  const anchorsRef = useRef<{ ey: number; py: number }[]>([]);
  const scrollSyncingRef = useRef(false);
  const programmaticRef = useRef(false);
  const dirtyRef = useRef(false);
  const debounceRef = useRef<number | null>(null);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastEditorMirrorRef = useRef<string>("");
  const mirrorHlRef = useRef<any>(null);

  const { entries: frontmatter, body, offsetLines } = useMemo(() => parseFrontmatter(content), [content]);
  const html = useMemo(() => renderMarkdown(body), [body]);
  const htmlObj = useMemo(() => ({ __html: html }), [html]);

  // latest values for stable CM callbacks
  const contentRef = useRef(content); contentRef.current = content;
  const activeIdRef = useRef(activeId); activeIdRef.current = activeId;
  const offsetRef = useRef(offsetLines); offsetRef.current = offsetLines;
  const lockedRef = useRef(locked); lockedRef.current = locked;

  function timeStr() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  function setSaved() { setStatus({ kind: "saved", at: timeStr() }); }

  const commitContent = useCallback(() => {
    if (!dirtyRef.current) return;
    const c = contentRef.current;
    setFiles((prev) => prev.map((f) => (f.id === activeIdRef.current ? { ...f, content: c, updated: Date.now() } : f)));
    dirtyRef.current = false;
    setSaved();
  }, []);

  function scheduleAutosave() {
    dirtyRef.current = true;
    setStatus({ kind: "saving" });
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => commitContent(), AUTOSAVE_DEBOUNCE);
  }

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
    setContent(doc);
    if (programmaticRef.current) return;
    scheduleAutosave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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

  // set editor doc when the active file changes
  function setEditorDoc(text: string) {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === text) return;
    programmaticRef.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    programmaticRef.current = false;
  }
  useEffect(() => {
    const f = files.find((x) => x.id === activeId);
    if (!f) return;
    setEditorDoc(f.content);
    setContent(f.content);
    setTitle(f.title);
    dirtyRef.current = false;
    setSaved();
    localStorage.setItem(LS_ACTIVE, f.id);
    clearPreviewMirror();
    clearEditorMirror();
    requestAnimationFrame(() => requestAnimationFrame(() => recomputeAnchors()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

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

  useEffect(() => { localStorage.setItem(LS_FILES, JSON.stringify(files)); }, [files]);
  useEffect(() => { localStorage.setItem(LS_LOCK, locked ? "1" : "0"); if (locked) recomputeAnchors(); }, [locked, recomputeAnchors]);

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

  // autosave safety net + preview-selection mirror + shortcuts + dnd guard
  useEffect(() => {
    const t = window.setInterval(() => { if (dirtyRef.current) commitContent(); }, AUTOSAVE_INTERVAL);
    return () => window.clearInterval(t);
  }, [commitContent]);

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
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (titleDirty) saveTitle(); commitContent(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => { window.removeEventListener("dragover", prevent); window.removeEventListener("drop", prevent); };
  }, []);
  useEffect(() => () => { if (dirtyRef.current) commitContent(); }, [commitContent]);

  // ---- file ops ----
  const active = files.find((f) => f.id === activeId) ?? null;
  const titleDirty = !!active && title.trim() !== active.title;
  function saveTitle() {
    if (!active) return;
    const t = title.trim() || "Untitled";
    setTitle(t);
    setFiles((prev) => prev.map((f) => (f.id === activeId ? { ...f, title: t, updated: Date.now() } : f)));
    setSaved();
  }
  function switchFile(id: string) { commitContent(); setActiveId(id); }
  function newFile() {
    commitContent();
    const f: MdFile = { id: uid(), title: "Untitled", content: "", updated: Date.now() };
    setFiles((prev) => [...prev, f]);
    setActiveId(f.id);
  }
  function deleteActive() {
    if (!active) return;
    if (!confirm(`Delete "${active.title || "Untitled"}"? This cannot be undone.`)) return;
    setFiles((prev) => {
      const next = prev.filter((f) => f.id !== active.id);
      if (!next.length) { const f = { id: uid(), title: "Untitled", content: "", updated: Date.now() }; setActiveId(f.id); return [f]; }
      setActiveId(next[0].id);
      return next;
    });
  }
  function downloadActive() {
    commitContent();
    const name = (title || "untitled").replace(/[\\/:*?"<>|]+/g, "_").trim() || "untitled";
    const blob = new Blob([contentRef.current], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${name}.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      const t = file.name.replace(/\.(md|markdown|mdx|txt)$/i, "").trim() || "Untitled";
      created.push({ id: uid(), title: t, content: text, updated: Date.now() });
    }
    if (!created.length) return;
    setFiles((prev) => [...prev, ...created]);
    setActiveId(created[0].id);
  }

  // ---- drag & drop ----
  function dragHasFiles(e: React.DragEvent) { return Array.from(e.dataTransfer?.types ?? []).includes("Files"); }
  function onDragEnter(e: React.DragEvent) { if (!dragHasFiles(e)) return; e.preventDefault(); dragDepth.current += 1; setDragActive(true); }
  function onDragOver(e: React.DragEvent) { if (!dragHasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
  function onDragLeave(e: React.DragEvent) { if (!dragHasFiles(e)) return; e.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragActive(false); }
  function onDrop(e: React.DragEvent) {
    e.preventDefault(); dragDepth.current = 0; setDragActive(false);
    const fs = Array.from(e.dataTransfer.files).filter(isMarkdownFile);
    if (fs.length) void uploadFiles(fs);
  }

  return (
    <div
      className="relative flex h-full flex-col bg-background text-foreground"
      onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
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

      <header className="flex flex-none flex-wrap items-center gap-2 border-b bg-card px-4 py-2.5">
        <div className="flex select-none items-center gap-2 pr-1 font-semibold tracking-tight">
          <span className="h-3.5 w-3.5 rotate-45 rounded-[4px] bg-gradient-to-br from-brand via-[#579fb5] to-muted-foreground shadow-sm" />
          Markdown <span className="hidden font-normal text-muted-foreground sm:inline">live editor</span>
        </div>
        <Separator orientation="vertical" className="mx-1 h-6" />

        <div className="relative">
          <FileText className="pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Select value={activeId} onValueChange={switchFile}>
            <SelectTrigger className="w-[190px] pl-8 font-medium"><SelectValue placeholder="Select a file" /></SelectTrigger>
            <SelectContent>
              {files.map((f) => (<SelectItem key={f.id} value={f.id}>{f.title || "Untitled"}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>

        <div className="relative flex min-w-[190px] flex-1 items-center">
          <Pencil className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={title} placeholder="Untitled" onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveTitle(); } }}
            className="pl-8 font-medium" style={{ paddingRight: titleDirty ? 84 : undefined }} />
          {titleDirty && (
            <Button size="sm" variant="secondary" onClick={saveTitle} className="absolute right-1 h-7 px-2.5">
              <Check className="h-3.5 w-3.5" /> Rename
            </Button>
          )}
        </div>

        <input ref={fileInputRef} type="file" accept=".md,.markdown,.mdx,.txt,text/markdown,text/plain" multiple className="hidden"
          onChange={(e) => { void uploadFiles(e.target.files); e.currentTarget.value = ""; }} />
        <Button variant="outline" onClick={newFile}><Plus /> New</Button>
        <Button variant="outline" onClick={() => fileInputRef.current?.click()}><Upload /> Load</Button>
        <Button onClick={downloadActive}><Download /> Save</Button>
        <Button variant="ghost" onClick={deleteActive} className="text-muted-foreground hover:bg-destructive hover:text-destructive-foreground">
          <Trash2 /> Delete
        </Button>

        <Separator orientation="vertical" className="mx-1 h-6" />
        <Button variant="outline" size="icon" aria-pressed={locked}
          title={locked ? "Scroll locked — click to unlock" : "Lock scroll between panes"}
          onClick={() => setLocked((v) => !v)} className={locked ? "border-brand bg-brand/15 text-foreground" : ""}>
          {locked ? <Lock /> : <LockOpen />}
        </Button>
        <Button variant="outline" size="icon" title="Toggle theme" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>
          {theme === "dark" ? <Sun /> : <Moon />}
        </Button>

        <div className="ml-auto flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
          <span className={`h-1.5 w-1.5 rounded-full ${status.kind === "saving" ? "animate-pulse bg-[#e79d26]" : "bg-brand"}`} />
          {status.kind === "saving" ? "Saving…" : `Saved · ${status.at ?? timeStr()}`}
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
            {frontmatter.length > 0 && (
              <div className="border-b px-10 pt-7 pb-5">
                <button type="button" onClick={() => setShowMeta((v) => !v)} className="flex w-full items-center gap-2 text-left">
                  <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${showMeta ? "" : "-rotate-90"}`} />
                  <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Frontmatter</span>
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">{frontmatter.length} field{frontmatter.length > 1 ? "s" : ""}</span>
                </button>
                <div className={`grid transition-all duration-200 ease-out ${showMeta ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
                  <div className="overflow-hidden">
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-2.5 pt-4 text-sm">
                      {frontmatter.map(({ key, value }) => (
                        <Fragment key={key}>
                          <dt className="pt-0.5 font-mono text-xs uppercase tracking-wide text-muted-foreground">{key}</dt>
                          <dd className="min-w-0">{renderFrontValue(value)}</dd>
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
