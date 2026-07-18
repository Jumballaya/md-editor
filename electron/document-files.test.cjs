const assert = require("node:assert/strict");
const test = require("node:test");
const { createDocumentFiles } = require("./document-files.cjs");

function fakeDialog(overrides = {}) {
  return {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 0 }),
    ...overrides,
  };
}

test("opening a document returns its path, filename, and contents", async () => {
  const dialog = fakeDialog({
    showOpenDialog: async () => ({ canceled: false, filePaths: ["/notes/readme.md"] }),
  });
  const files = createDocumentFiles({ dialog, readFile: async () => "# Hello" });

  const result = await files.open({});

  assert.deepEqual(result, {
    status: "opened",
    document: { path: "/notes/readme.md", name: "readme.md", content: "# Hello" },
  });
});

test("cancelling the open dialog leaves the current document alone", async () => {
  const files = createDocumentFiles({
    dialog: fakeDialog(),
    readFile: async () => assert.fail("cancelled opens must not read a file"),
  });

  assert.deepEqual(await files.open({}), { status: "cancelled" });
});

test("saving writes the complete UTF-8 document to its existing path", async () => {
  const writes = [];
  const files = createDocumentFiles({
    dialog: fakeDialog(),
    writeFile: async (...args) => writes.push(args),
  });

  assert.deepEqual(await files.save("/notes/readme.md", "updated"), { status: "saved" });
  assert.deepEqual(writes, [["/notes/readme.md", "updated", "utf8"]]);
});

test("Save As chooses a Markdown filename, writes it, and returns the new identity", async () => {
  const writes = [];
  let dialogOptions;
  const files = createDocumentFiles({
    dialog: fakeDialog({
      showSaveDialog: async (_owner, options) => {
        dialogOptions = options;
        return { canceled: false, filePath: "/notes/field-notes.md" };
      },
    }),
    writeFile: async (...args) => writes.push(args),
  });

  const result = await files.saveAs({}, { title: "Field notes", content: "# Notes" });

  assert.equal(dialogOptions.defaultPath, "Field notes.md");
  assert.deepEqual(writes, [["/notes/field-notes.md", "# Notes", "utf8"]]);
  assert.deepEqual(result, {
    status: "saved",
    document: { path: "/notes/field-notes.md", name: "field-notes.md" },
  });
});

test("cancelling Save As does not write or attach a path", async () => {
  const files = createDocumentFiles({
    dialog: fakeDialog(),
    writeFile: async () => assert.fail("cancelled saves must not write a file"),
  });

  assert.deepEqual(await files.saveAs({}, { title: "Untitled", content: "draft" }), { status: "cancelled" });
});

test("filesystem failures become renderer-safe error results", async () => {
  const files = createDocumentFiles({
    dialog: fakeDialog(),
    readFile: async () => { throw new Error("permission denied"); },
    writeFile: async () => { throw new Error("disk full"); },
  });

  assert.deepEqual(await files.read("/private.md"), {
    status: "error",
    message: "Couldn't open the document (permission denied).",
  });
  assert.deepEqual(await files.save("/private.md", "content"), {
    status: "error",
    message: "Couldn't save the document (disk full).",
  });
});

test("the unsaved dialog maps native button choices to document actions", async () => {
  let response = 0;
  const files = createDocumentFiles({
    dialog: fakeDialog({ showMessageBox: async () => ({ response }) }),
  });

  assert.equal(await files.confirmUnsaved({}, { title: "notes.md" }), "save");
  response = 1;
  assert.equal(await files.confirmUnsaved({}, { title: "notes.md" }), "discard");
  response = 2;
  assert.equal(await files.confirmUnsaved({}, { title: "notes.md" }), "cancel");
});

test("the disk-conflict dialog defaults to preserving both versions", async () => {
  let response = 0;
  let options;
  const files = createDocumentFiles({
    dialog: fakeDialog({
      showMessageBox: async (_owner, received) => {
        options = received;
        return { response };
      },
    }),
  });

  assert.equal(await files.confirmExternalChange({}, { title: "notes.md" }), "save-copy");
  assert.equal(options.defaultId, 0);
  response = 1;
  assert.equal(await files.confirmExternalChange({}, { title: "notes.md" }), "overwrite");
  response = 2;
  assert.equal(await files.confirmExternalChange({}, { title: "notes.md" }), "reload");
  response = 3;
  assert.equal(await files.confirmExternalChange({}, { title: "notes.md" }), "cancel");
});
