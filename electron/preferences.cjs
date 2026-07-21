const fs = require("fs/promises");
const path = require("path");

const preferencesVersion = 1;

function errorResult(action, error) {
  const detail = error instanceof Error ? error.message : String(error);
  return { status: "error", message: `Couldn't ${action} preferences (${detail}).` };
}

function validBounds(value) {
  if (!value || typeof value !== "object") return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isFinite) || width < 640 || height < 420) return null;
  return { x, y, width, height };
}

function storedDocument(value) {
  if (!value || typeof value !== "object") return null;
  if (value.kind === "local" && typeof value.path === "string" && value.path) {
    return { kind: "local", path: value.path };
  }
  if (value.kind === "remote" && typeof value.url === "string" && value.url && typeof value.title === "string" && typeof value.content === "string") {
    return { kind: "remote", url: value.url, title: value.title, content: value.content };
  }
  return null;
}

function savedDocument(document) {
  if (!document || typeof document !== "object") return null;
  if (document.source?.kind === "local" && typeof document.source.path === "string" && document.source.path) {
    return { kind: "local", path: document.source.path };
  }
  if (document.source?.kind === "remote" && typeof document.source.url === "string" && typeof document.title === "string" && typeof document.savedContent === "string") {
    return { kind: "remote", url: document.source.url, title: document.title, content: document.savedContent };
  }
  return null;
}

function createPreferences({
  filePath,
  readFile = fs.readFile,
  writeFile = fs.writeFile,
  rename = fs.rename,
  mkdir = fs.mkdir,
}) {
  const temporaryPath = `${filePath}.tmp`;
  let preferences = null;
  let pending = Promise.resolve();

  function serialized(operation) {
    const result = pending.then(operation, operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  async function load() {
    if (preferences) return preferences;
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      preferences = parsed?.version === preferencesVersion
        ? {
            version: preferencesVersion,
            window: validBounds(parsed.window?.bounds)
              ? { bounds: validBounds(parsed.window.bounds), maximized: parsed.window.maximized === true }
              : undefined,
            document: storedDocument(parsed.document) || undefined,
          }
        : { version: preferencesVersion };
    } catch {
      preferences = { version: preferencesVersion };
    }
    return preferences;
  }

  async function write() {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(preferences), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
  }

  return {
    windowState: () => serialized(async () => {
      const current = await load();
      return current.window || null;
    }),

    rememberWindow: (window) => serialized(async () => {
      const bounds = validBounds(window?.bounds);
      if (!bounds) return errorResult("save", new Error("invalid window bounds"));
      const current = await load();
      current.window = { bounds, maximized: window.maximized === true };
      try {
        await write();
        return { status: "saved" };
      } catch (error) {
        return errorResult("save", error);
      }
    }),

    rememberDocument: (document) => serialized(async () => {
      const current = await load();
      const next = savedDocument(document);
      if (JSON.stringify(current.document || null) === JSON.stringify(next)) return { status: "saved" };
      if (next) current.document = next;
      else delete current.document;
      try {
        await write();
        return { status: "saved" };
      } catch (error) {
        return errorResult("save", error);
      }
    }),

    restoreDocument: () => serialized(async () => {
      const current = await load();
      const document = current.document;
      if (!document) return { status: "none" };
      if (document.kind === "remote") {
        return {
          status: "restored",
          document: {
            source: { kind: "remote", url: document.url },
            title: document.title,
            content: document.content,
            savedContent: document.content,
          },
        };
      }
      try {
        const content = await readFile(document.path, "utf8");
        return {
          status: "restored",
          document: {
            source: { kind: "local", path: document.path },
            title: path.basename(document.path),
            content,
            savedContent: content,
          },
        };
      } catch (error) {
        if (error?.code !== "ENOENT") return errorResult("restore", error);
        delete current.document;
        try {
          await write();
        } catch (writeError) {
          return errorResult("save", writeError);
        }
        return { status: "none" };
      }
    }),
  };
}

module.exports = { createPreferences };
