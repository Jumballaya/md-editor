type OpenDocumentResult =
  | { status: "opened"; document: { path: string; name: string; content: string } }
  | { status: "cancelled" }
  | { status: "error"; message: string };

type SaveDocumentResult = { status: "saved" } | { status: "error"; message: string };
type SaveDocumentAsResult =
  | { status: "saved"; document: { path: string; name: string } }
  | { status: "cancelled" }
  | { status: "error"; message: string };
type UnsavedChoice = "save" | "discard" | "cancel";

interface DesktopDocuments {
  open(): Promise<OpenDocumentResult>;
  openDroppedFile(file: File): Promise<OpenDocumentResult>;
  save(request: { path: string; content: string }): Promise<SaveDocumentResult>;
  saveAs(request: { title: string; content: string }): Promise<SaveDocumentAsResult>;
  confirmUnsaved(request: { title: string }): Promise<UnsavedChoice>;
  setCloseState(state: { dirty: boolean; title: string }): void;
  finishCloseSave(saved: boolean): void;
  onSaveBeforeClose(callback: () => void): () => void;
}

interface Window {
  desktopDocuments?: DesktopDocuments;
}
