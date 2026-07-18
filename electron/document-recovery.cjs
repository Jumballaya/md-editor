const fs = require("fs/promises");
const path = require("path");

const recoveryVersion = 1;

function errorResult(action, error) {
  const detail = error instanceof Error ? error.message : String(error);
  return { status: "error", message: `Couldn't ${action} the recovery copy (${detail}).` };
}

function documentSource(value) {
  if (!value || typeof value !== "object") return null;
  if (value.kind === "new") return { kind: "new" };
  if (value.kind === "local" && typeof value.path === "string" && value.path) {
    return { kind: "local", path: value.path };
  }
  if (value.kind === "remote" && typeof value.url === "string" && value.url) {
    return { kind: "remote", url: value.url };
  }
  return null;
}

function recoveryDocument(value) {
  if (!value || typeof value !== "object") return null;
  const source = documentSource(value.source);
  if (!source || typeof value.title !== "string" || typeof value.content !== "string" || typeof value.savedContent !== "string") {
    return null;
  }
  return {
    source,
    title: value.title,
    content: value.content,
    savedContent: value.savedContent,
  };
}

function createDocumentRecovery({
  filePath,
  dialog,
  readFile = fs.readFile,
  writeFile = fs.writeFile,
  rename = fs.rename,
  mkdir = fs.mkdir,
  unlink = fs.unlink,
}) {
  const temporaryPath = `${filePath}.tmp`;
  let pending = Promise.resolve();

  function serialized(operation) {
    const result = pending.then(operation, operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  async function discardNow() {
    try {
      await unlink(filePath);
      return { status: "cleared" };
    } catch (error) {
      if (error?.code === "ENOENT") return { status: "cleared" };
      return errorResult("remove", error);
    }
  }

  async function updateNow(value) {
    const document = recoveryDocument(value);
    if (!document) return { status: "error", message: "Couldn't update the recovery copy (invalid request)." };
    if (document.content === document.savedContent) return discardNow();

    const record = JSON.stringify({ version: recoveryVersion, document });
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(temporaryPath, record, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, filePath);
      return { status: "updated" };
    } catch (error) {
      try { await unlink(temporaryPath); } catch { /* best-effort cleanup */ }
      return errorResult("update", error);
    }
  }

  async function readRecord() {
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { status: "none" };
      return errorResult("read", error);
    }

    try {
      const record = JSON.parse(raw);
      const document = record?.version === recoveryVersion ? recoveryDocument(record.document) : null;
      if (!document || document.content === document.savedContent) {
        await discardNow();
        return { status: "error", message: "Couldn't read the recovery copy (invalid data)." };
      }
      return { status: "found", document };
    } catch {
      await discardNow();
      return { status: "error", message: "Couldn't read the recovery copy (invalid data)." };
    }
  }

  async function restoreNow(owner) {
    const stored = await readRecord();
    if (stored.status !== "found") return stored;
    const document = stored.document;

    if (document.source.kind === "local") {
      let diskContent;
      try {
        diskContent = await readFile(document.source.path, "utf8");
      } catch (error) {
        return errorResult("verify", error);
      }
      if (diskContent !== document.savedContent) {
        await dialog.showMessageBox(owner, {
          type: "info",
          title: "Recovery copy not restored",
          message: `${document.title || "This document"} changed on disk`,
          detail: "The recovery copy was based on an older version, so it was not restored.",
          buttons: ["Continue"],
          defaultId: 0,
          noLink: true,
        });
        const cleared = await discardNow();
        return cleared.status === "error" ? cleared : { status: "none" };
      }
    }

    const answer = await dialog.showMessageBox(owner, {
      type: "question",
      title: "Restore unsaved changes",
      message: `Restore unsaved changes to ${document.title || "this document"}?`,
      detail: document.source.kind === "local"
        ? "The file on disk still matches the version these edits were based on."
        : "Markdown Editor found a local recovery copy from the previous session.",
      buttons: ["Restore", "Discard"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (answer.response === 0) return { status: "restored", document };
    const cleared = await discardNow();
    return cleared.status === "error" ? cleared : { status: "none" };
  }

  return {
    update: (document) => serialized(() => updateNow(document)),
    restore: (owner) => serialized(() => restoreNow(owner)),
    discard: () => serialized(discardNow),
  };
}

module.exports = { createDocumentRecovery };
