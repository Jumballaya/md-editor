const assert = require("node:assert/strict");
const test = require("node:test");
const { createDocumentWatcher } = require("./document-watcher.cjs");

function missingFile(filePath) {
  const error = new Error(`ENOENT: ${filePath}`);
  error.code = "ENOENT";
  return error;
}

function watcherHarness(initial = {}) {
  const files = new Map(Object.entries(initial));
  const directoryWatchers = [];
  const events = [];
  const watcher = createDocumentWatcher({
    onChange: (event) => events.push(event),
    debounceMs: 0,
    readFile: async (filePath) => {
      if (!files.has(filePath)) throw missingFile(filePath);
      return files.get(filePath);
    },
    watchDirectory: (directory, callback) => {
      const entry = { directory, callback, closed: false };
      directoryWatchers.push(entry);
      return {
        close: () => { entry.closed = true; },
        on: () => {},
      };
    },
  });
  return { files, directoryWatchers, events, watcher };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

test("external writes are coalesced and emitted with their complete content", async () => {
  const harness = watcherHarness({ "/notes/readme.md": "original" });
  harness.watcher.update({ path: "/notes/readme.md", content: "original" });
  harness.files.set("/notes/readme.md", "external edit");

  harness.directoryWatchers[0].callback("change", "readme.md");
  harness.directoryWatchers[0].callback("change", "readme.md");
  await settle();

  assert.deepEqual(harness.events, [{ status: "changed", path: "/notes/readme.md", content: "external edit" }]);
});

test("acknowledging our own save before the disk check suppresses its event", async () => {
  const harness = watcherHarness({ "/notes/readme.md": "original" });
  harness.watcher.update({ path: "/notes/readme.md", content: "original" });
  harness.files.set("/notes/readme.md", "our save");
  harness.directoryWatchers[0].callback("change", "readme.md");

  harness.watcher.update({ path: "/notes/readme.md", content: "our save" });
  await settle();

  assert.deepEqual(harness.events, []);
});

test("missing files are reported once and unrelated directory events are ignored", async () => {
  const harness = watcherHarness({ "/notes/readme.md": "original" });
  harness.watcher.update({ path: "/notes/readme.md", content: "original" });
  harness.files.delete("/notes/readme.md");

  harness.directoryWatchers[0].callback("rename", "other.md");
  harness.directoryWatchers[0].callback("rename", "readme.md");
  await settle();
  harness.directoryWatchers[0].callback("rename", "readme.md");
  await settle();

  assert.deepEqual(harness.events, [{ status: "missing", path: "/notes/readme.md" }]);
});

test("switching documents closes the previous directory watcher", () => {
  const harness = watcherHarness();
  harness.watcher.update({ path: "/notes/one.md", content: "one" });
  harness.watcher.update({ path: "/drafts/two.md", content: "two" });

  assert.equal(harness.directoryWatchers[0].closed, true);
  assert.equal(harness.directoryWatchers[1].directory, "/drafts");
});
