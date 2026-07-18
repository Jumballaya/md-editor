const assert = require("node:assert/strict");
const test = require("node:test");
const { createDocumentRecovery } = require("./document-recovery.cjs");

const recoveryPath = "/app-data/document-recovery.json";

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
    unlink: async (filePath) => {
      if (!files.delete(filePath)) throw missingFile(filePath);
    },
  };
}

function localSession(overrides = {}) {
  return {
    source: { kind: "local", path: "/notes/readme.md" },
    title: "readme.md",
    content: "edited",
    savedContent: "on disk",
    ...overrides,
  };
}

function fakeDialog(response = 0) {
  const calls = [];
  return {
    calls,
    showMessageBox: async (_owner, options) => {
      calls.push(options);
      return { response };
    },
  };
}

test("dirty edits are written atomically and restored when the disk baseline still matches", async () => {
  const storage = memoryFiles({ "/notes/readme.md": "on disk" });
  const dialog = fakeDialog();
  const recovery = createDocumentRecovery({ filePath: recoveryPath, dialog, ...storage });

  assert.deepEqual(await recovery.update(localSession()), { status: "updated" });
  assert.equal(storage.files.has(`${recoveryPath}.tmp`), false);
  assert.deepEqual(JSON.parse(storage.files.get(recoveryPath)), {
    version: 1,
    document: localSession(),
  });

  assert.deepEqual(await recovery.restore({}), { status: "restored", document: localSession() });
  assert.equal(dialog.calls[0].buttons[0], "Restore");
  assert.equal(storage.files.has(recoveryPath), true);
});

test("a clean document clears its recovery copy", async () => {
  const storage = memoryFiles({ "/notes/readme.md": "on disk" });
  const recovery = createDocumentRecovery({ filePath: recoveryPath, dialog: fakeDialog(), ...storage });
  await recovery.update(localSession());

  assert.deepEqual(await recovery.update(localSession({ content: "on disk" })), { status: "cleared" });
  assert.equal(storage.files.has(recoveryPath), false);
});

test("recovery opens as a detached copy when the local file changed", async () => {
  const storage = memoryFiles({ "/notes/readme.md": "on disk" });
  const dialog = fakeDialog();
  const recovery = createDocumentRecovery({ filePath: recoveryPath, dialog, ...storage });
  await recovery.update(localSession());
  storage.files.set("/notes/readme.md", "newer disk content");

  assert.deepEqual(await recovery.restore({}), {
    status: "restored",
    document: {
      ...localSession(),
      source: { kind: "detached", previousPath: "/notes/readme.md" },
    },
  });
  assert.deepEqual(dialog.calls[0].buttons, ["Continue"]);
  assert.equal(JSON.parse(storage.files.get(recoveryPath)).document.source.kind, "detached");
});

test("discarding the restore prompt removes the recovery copy", async () => {
  const storage = memoryFiles();
  const dialog = fakeDialog(1);
  const recovery = createDocumentRecovery({ filePath: recoveryPath, dialog, ...storage });
  const draft = {
    source: { kind: "new" },
    title: "Untitled",
    content: "draft",
    savedContent: "",
  };
  await recovery.update(draft);

  assert.deepEqual(await recovery.restore({}), { status: "none" });
  assert.equal(storage.files.has(recoveryPath), false);
});

test("restoring a remote edit preserves its original baseline and dirty state", async () => {
  const storage = memoryFiles();
  const recovery = createDocumentRecovery({ filePath: recoveryPath, dialog: fakeDialog(), ...storage });
  const remote = {
    source: { kind: "remote", url: "https://example.com/readme.md" },
    title: "readme.md",
    content: "remote with edits",
    savedContent: "remote",
  };
  await recovery.update(remote);

  assert.deepEqual(await recovery.restore({}), { status: "restored", document: remote });
  assert.notEqual(remote.content, remote.savedContent);
});

test("a detached disk copy remains recoverable even when its text matches the old baseline", async () => {
  const storage = memoryFiles();
  const recovery = createDocumentRecovery({ filePath: recoveryPath, dialog: fakeDialog(), ...storage });
  const detached = {
    source: { kind: "detached", previousPath: "/notes/deleted.md" },
    title: "deleted.md",
    content: "last disk content",
    savedContent: "last disk content",
  };

  assert.deepEqual(await recovery.update(detached), { status: "updated" });
  assert.deepEqual(await recovery.restore({}), { status: "restored", document: detached });
});

test("a temporarily unavailable local file leaves its recovery copy intact", async () => {
  const storage = memoryFiles({ "/notes/readme.md": "on disk" });
  const recovery = createDocumentRecovery({ filePath: recoveryPath, dialog: fakeDialog(), ...storage });
  await recovery.update(localSession());
  storage.files.delete("/notes/readme.md");

  const result = await recovery.restore({});

  assert.equal(result.status, "error");
  assert.match(result.message, /verify the recovery copy/);
  assert.equal(storage.files.has(recoveryPath), true);
});

test("invalid recovery data is removed instead of entering the editor", async () => {
  const storage = memoryFiles({ [recoveryPath]: "not json" });
  const recovery = createDocumentRecovery({ filePath: recoveryPath, dialog: fakeDialog(), ...storage });

  assert.deepEqual(await recovery.restore({}), {
    status: "error",
    message: "Couldn't read the recovery copy (invalid data).",
  });
  assert.equal(storage.files.has(recoveryPath), false);
});
