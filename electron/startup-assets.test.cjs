const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("the desktop shell has no render-blocking network dependencies", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const remoteLinks = Array.from(html.matchAll(/<link\b[^>]*\bhref=["']https?:\/\/[^"']+["'][^>]*>/gi), ([link]) => link);

  assert.deepEqual(remoteLinks, []);
});
