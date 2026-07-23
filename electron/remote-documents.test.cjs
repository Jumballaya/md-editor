const assert = require("node:assert/strict");
const test = require("node:test");
const { createRemoteDocuments } = require("./remote-documents.cjs");

test("opening a remote document returns its fetched URL, filename, and contents", async () => {
  const requests = [];
  const remote = createRemoteDocuments({
    fetch: async (...args) => {
      requests.push(args);
      return { ok: true, status: 200, text: async () => "# Remote" };
    },
  });

  const result = await remote.open("https://example.com/notes/field%20notes.md");

  assert.equal(requests[0][0], "https://example.com/notes/field%20notes.md");
  assert.deepEqual(result, {
    status: "opened",
    document: {
      url: "https://example.com/notes/field%20notes.md",
      name: "field notes.md",
      content: "# Remote",
    },
  });
});

test("GitHub file pages are fetched through raw.githubusercontent.com", async () => {
  let requestedUrl;
  const remote = createRemoteDocuments({
    fetch: async (url) => {
      requestedUrl = url;
      return { ok: true, status: 200, text: async () => "# Readme" };
    },
  });

  const result = await remote.open("https://github.com/Jumballaya/md-editor/blob/main/README.md");

  assert.equal(requestedUrl, "https://raw.githubusercontent.com/Jumballaya/md-editor/main/README.md");
  assert.equal(result.document.name, "README.md");
  assert.equal(result.document.url, "https://raw.githubusercontent.com/Jumballaya/md-editor/main/README.md");
});

test("invalid and non-http URLs are rejected before fetching", async () => {
  const remote = createRemoteDocuments({ fetch: async () => assert.fail("invalid URLs must not be fetched") });

  assert.deepEqual(await remote.open("not a URL"), { status: "error", message: "Enter a valid http(s) URL." });
  assert.deepEqual(await remote.open("file:///tmp/notes.md"), { status: "error", message: "Enter a valid http(s) URL." });
});

test("HTTP and network failures become actionable renderer errors", async () => {
  const notFound = createRemoteDocuments({
    fetch: async () => ({ ok: false, status: 404 }),
  });
  const offline = createRemoteDocuments({
    fetch: async () => { throw new Error("network offline"); },
  });

  assert.deepEqual(await notFound.open("https://example.com/missing.md"), {
    status: "error",
    message: "Couldn't open that URL (HTTP 404).",
  });
  assert.deepEqual(await offline.open("https://example.com/notes.md"), {
    status: "error",
    message: "Couldn't reach that URL (network offline).",
  });
});
