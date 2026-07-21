const assert = require("node:assert/strict");
const test = require("node:test");
const { createPreferences } = require("./preferences.cjs");

const preferencesPath = "/app-data/preferences.json";

function missingFile(filePath) {
  const error = new Error(`ENOENT: ${filePath}`);
  error.code = "ENOENT";
  return error;
}

function memoryFiles(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (filePath) => {
      if (!files.has(filePath)) throw missingFile(filePath);
      return files.get(filePath);
    },
    writeFile: async (filePath, content) => { files.set(filePath, content); },
    rename: async (from, to) => {
      if (!files.has(from)) throw missingFile(from);
      files.set(to, files.get(from));
      files.delete(from);
    },
    mkdir: async () => {},
  };
}

function localSession(path = "/notes/today.md") {
  return {
    source: { kind: "local", path },
    title: "today.md",
    content: "edited in memory",
    savedContent: "saved baseline",
  };
}

test("a local document reopens with fresh disk content", async () => {
  const storage = memoryFiles({ "/notes/today.md": "first disk version" });
  const preferences = createPreferences({ filePath: preferencesPath, ...storage });
  await preferences.rememberDocument(localSession());
  storage.files.set("/notes/today.md", "new disk version");

  assert.deepEqual(await preferences.restoreDocument(), {
    status: "restored",
    document: {
      source: { kind: "local", path: "/notes/today.md" },
      title: "today.md",
      content: "new disk version",
      savedContent: "new disk version",
    },
  });
});

test("a remote copy reopens from its clean baseline", async () => {
  const storage = memoryFiles();
  const preferences = createPreferences({ filePath: preferencesPath, ...storage });
  await preferences.rememberDocument({
    source: { kind: "remote", url: "https://example.com/readme.md" },
    title: "readme.md",
    content: "dirty edit",
    savedContent: "downloaded copy",
  });

  assert.deepEqual(await preferences.restoreDocument(), {
    status: "restored",
    document: {
      source: { kind: "remote", url: "https://example.com/readme.md" },
      title: "readme.md",
      content: "downloaded copy",
      savedContent: "downloaded copy",
    },
  });
});

test("new and detached documents clear the previous document", async () => {
  const storage = memoryFiles({ "/notes/today.md": "disk" });
  const preferences = createPreferences({ filePath: preferencesPath, ...storage });
  await preferences.rememberDocument(localSession());
  await preferences.rememberDocument({
    source: { kind: "new" },
    title: "Untitled",
    content: "",
    savedContent: "",
  });

  assert.deepEqual(await preferences.restoreDocument(), { status: "none" });
});

test("a missing previous local file is forgotten", async () => {
  const storage = memoryFiles();
  const preferences = createPreferences({ filePath: preferencesPath, ...storage });
  await preferences.rememberDocument(localSession("/notes/missing.md"));

  assert.deepEqual(await preferences.restoreDocument(), { status: "none" });
  assert.equal(JSON.parse(storage.files.get(preferencesPath)).document, undefined);
});

test("window bounds and maximized state survive a new store instance", async () => {
  const storage = memoryFiles();
  const first = createPreferences({ filePath: preferencesPath, ...storage });
  const window = { bounds: { x: 40, y: 60, width: 1280, height: 760 }, maximized: true };
  await first.rememberWindow(window);

  const second = createPreferences({ filePath: preferencesPath, ...storage });
  assert.deepEqual(await second.windowState(), window);
});

test("invalid preferences fall back to defaults", async () => {
  const storage = memoryFiles({ [preferencesPath]: "not json" });
  const preferences = createPreferences({ filePath: preferencesPath, ...storage });

  assert.equal(await preferences.windowState(), null);
  assert.deepEqual(await preferences.restoreDocument(), { status: "none" });
});
