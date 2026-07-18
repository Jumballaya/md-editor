export type DocumentSource =
  | { kind: "new" }
  | { kind: "local"; path: string }
  | { kind: "detached"; previousPath: string }
  | { kind: "remote"; url: string };

export type DocumentSession = {
  source: DocumentSource;
  title: string;
  content: string;
  savedContent: string;
};

export function welcomeDocument(content: string): DocumentSession {
  return { source: { kind: "new" }, title: "Welcome", content, savedContent: content };
}

export function newDocument(): DocumentSession {
  return { source: { kind: "new" }, title: "Untitled", content: "", savedContent: "" };
}

export function localDocument(path: string, title: string, content: string): DocumentSession {
  return { source: { kind: "local", path }, title, content, savedContent: content };
}

export function remoteDocument(url: string, title: string, content: string): DocumentSession {
  return { source: { kind: "remote", url }, title, content, savedContent: content };
}

export function detachedDocument(document: DocumentSession): DocumentSession {
  if (document.source.kind !== "local") return document;
  return { ...document, source: { kind: "detached", previousPath: document.source.path } };
}

export function isDocumentDirty(document: DocumentSession): boolean {
  return document.source.kind === "detached" || document.content !== document.savedContent;
}
