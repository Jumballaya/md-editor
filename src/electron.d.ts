import type { DocumentSession } from "@/lib/document-session";

type OpenDocumentResult =
  | { status: "opened"; document: { path: string; name: string; content: string } }
  | { status: "cancelled" }
  | { status: "error"; message: string };
type OpenRemoteDocumentResult =
  | { status: "opened"; document: { url: string; name: string; content: string } }
  | { status: "error"; message: string };

type SaveDocumentResult = { status: "saved" } | { status: "error"; message: string };
type SaveDocumentAsResult =
  | { status: "saved"; document: { path: string; name: string } }
  | { status: "cancelled" }
  | { status: "error"; message: string };
type UnsavedChoice = "save" | "discard" | "cancel";
type ExternalChangeChoice = "save-copy" | "overwrite" | "reload" | "cancel";
type MenuCommand = "new" | "open" | "open-url" | "save" | "save-as";
export type ExternalDocumentChange =
  | { status: "changed"; path: string; content: string }
  | { status: "missing"; path: string }
  | { status: "error"; path: string | null; message: string };
type RecoveryUpdateResult = { status: "updated" | "cleared" } | { status: "error"; message: string };
type RecoveryRestoreResult =
  | { status: "restored"; document: DocumentSession }
  | { status: "none" }
  | { status: "error"; message: string };
type PreferenceUpdateResult = { status: "saved" } | { status: "error"; message: string };
type PreviousDocumentRestoreResult =
  | { status: "restored"; document: DocumentSession }
  | { status: "none" }
  | { status: "error"; message: string };

interface DesktopDocuments {
  open(): Promise<OpenDocumentResult>;
  openDroppedFile(file: File): Promise<OpenDocumentResult>;
  openRemote(url: string): Promise<OpenRemoteDocumentResult>;
  save(request: { path: string; content: string }): Promise<SaveDocumentResult>;
  saveAs(request: { title: string; content: string }): Promise<SaveDocumentAsResult>;
  confirmUnsaved(request: { title: string }): Promise<UnsavedChoice>;
  confirmExternalChange(request: { title: string }): Promise<ExternalChangeChoice>;
  updateRecovery(document: DocumentSession): Promise<RecoveryUpdateResult>;
  restoreRecovery(): Promise<RecoveryRestoreResult>;
  rememberDocument(document: DocumentSession): Promise<PreferenceUpdateResult>;
  restorePreviousDocument(): Promise<PreviousDocumentRestoreResult>;
  watchLocal(request: { path: string; content: string }): void;
  stopWatching(): void;
  setCloseState(state: { dirty: boolean; title: string }): void;
  finishCloseSave(saved: boolean): void;
  onSaveBeforeClose(callback: () => void): () => void;
  onExternalChange(callback: (change: ExternalDocumentChange) => void): () => void;
  onMenuCommand(callback: (command: MenuCommand) => void): () => void;
}

declare global {
  interface Window {
    desktopDocuments: DesktopDocuments;
  }
}

export {};
