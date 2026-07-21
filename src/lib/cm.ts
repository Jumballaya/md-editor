import { EditorView, keymap, drawSelection, Decoration } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { EditorState, Compartment, StateField, StateEffect } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";

// Mirror decoration: highlight an exact text range (preview selection -> editor).
export const setMirror = StateEffect.define<{ from: number; to: number } | null>();
const mirrorMark = Decoration.mark({ class: "cm-mirror" });
export const mirrorField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setMirror)) {
        if (!e.value) return Decoration.none;
        const len = tr.state.doc.length;
        const from = Math.max(0, Math.min(e.value.from, len));
        const to = Math.max(from, Math.min(e.value.to, len));
        if (to <= from) return Decoration.none;
        return Decoration.set([mirrorMark.range(from, to)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

// Plain editor styling that matches the original monospace textarea look:
// same font, size, line-height, generous padding, mint caret/selection, no
// active-line wash, no syntax coloring (uniform text).
function editorTheme(dark: boolean) {
  return EditorView.theme(
    {
      "&": { height: "100%", backgroundColor: "transparent", color: "inherit" },
      ".cm-scroller": { fontFamily: mono, fontSize: "13.5px", lineHeight: "1.75", overflow: "auto" },
      ".cm-content": { padding: "22px 24px", caretColor: dark ? "#aee9bd" : "#1f9d55" },
      ".cm-line": { padding: "0" },
      "&.cm-editor.cm-focused": { outline: "none" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: dark ? "#aee9bd" : "#1f9d55" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: dark ? "rgba(174,233,189,0.22)" : "rgba(31,157,85,0.16)",
      },
      ".cm-mirror": { backgroundColor: "var(--mirror)", borderRadius: "2px" },
    },
    { dark }
  );
}

export const themeCompartment = new Compartment();
export function themeExtensions(dark: boolean) {
  return [editorTheme(dark)];
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
