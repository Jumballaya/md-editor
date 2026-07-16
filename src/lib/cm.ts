import { EditorView, keymap, drawSelection, highlightActiveLine, Decoration } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { EditorState, Compartment, StateField, StateEffect, RangeSetBuilder } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle, foldGutter } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// ---- mirror line decoration (preview selection -> highlight editor lines) ----
export const setMirrorLines = StateEffect.define<{ from: number; to: number } | null>();
export const mirrorField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setMirrorLines)) {
        if (!e.value) return Decoration.none;
        const b = new RangeSetBuilder<Decoration>();
        const doc = tr.state.doc;
        const from = Math.max(0, Math.min(e.value.from, doc.length));
        const to = Math.max(0, Math.min(e.value.to, doc.length));
        const start = doc.lineAt(Math.min(from, to)).number;
        const end = doc.lineAt(Math.max(from, to)).number;
        for (let ln = start; ln <= end; ln++) {
          const line = doc.line(ln);
          b.add(line.from, line.from, Decoration.line({ class: "cm-mirror-line" }));
        }
        return b.finish();
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const mono = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

function baseTheme(dark: boolean) {
  return EditorView.theme(
    {
      "&": { height: "100%", backgroundColor: "transparent", color: "inherit" },
      ".cm-scroller": { fontFamily: mono, fontSize: "13.5px", lineHeight: "1.7", overflow: "auto" },
      ".cm-content": { padding: "20px 0", caretColor: dark ? "#aee9bd" : "#1f9d55" },
      ".cm-gutters": { backgroundColor: "transparent", border: "none", color: dark ? "#6e7681" : "#b0b0b0" },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 12px" },
      ".cm-activeLine": { backgroundColor: dark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)" },
      ".cm-activeLineGutter": { backgroundColor: "transparent" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: dark ? "rgba(174,233,189,0.22)" : "rgba(31,157,85,0.16)",
      },
      ".cm-mirror-line": { backgroundColor: dark ? "rgba(68,147,248,0.30)" : "rgba(9,105,218,0.18)" },
      "&.cm-editor.cm-focused": { outline: "none" },
      ".cm-cursor": { borderLeftColor: dark ? "#aee9bd" : "#1f9d55" },
    },
    { dark }
  );
}

function mdHighlight(dark: boolean) {
  const heading = dark ? "#e6edf3" : "#1a1a1a";
  const muted = dark ? "#8b949e" : "#8a8f98";
  const code = dark ? "#aee9bd" : "#1f9d55";
  const link = dark ? "#4493f8" : "#0969da";
  return HighlightStyle.define([
    { tag: t.heading, color: heading, fontWeight: "700" },
    { tag: t.strong, fontWeight: "700" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.link, color: link, textDecoration: "underline" },
    { tag: t.url, color: link },
    { tag: [t.monospace], color: code },
    { tag: [t.processingInstruction, t.meta], color: muted },
    { tag: t.strikethrough, textDecoration: "line-through" },
  ]);
}

export const themeCompartment = new Compartment();

export function themeExtensions(dark: boolean) {
  return [baseTheme(dark), syntaxHighlighting(mdHighlight(dark))];
}

export function createEditor(opts: {
  parent: HTMLElement;
  doc: string;
  dark: boolean;
  onDocChange: (doc: string) => void;
  onSelection: (from: number, to: number, empty: boolean) => void;
  onScroll: () => void;
}): EditorView {
  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        markdown(),
        mirrorField,
        themeCompartment.of(themeExtensions(opts.dark)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onDocChange(u.state.doc.toString());
          if (u.selectionSet) {
            const s = u.state.selection.main;
            opts.onSelection(s.from, s.to, s.empty);
          }
        }),
      ],
    }),
  });
  view.scrollDOM.addEventListener("scroll", opts.onScroll, { passive: true });
  return view;
}
