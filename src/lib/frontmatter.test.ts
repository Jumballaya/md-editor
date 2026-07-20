import assert from "node:assert/strict";
import test from "node:test";
import { parseFrontmatter } from "./frontmatter.ts";

test("YAML frontmatter preserves scalar types, collections, nesting, and multiline text", () => {
  const source = `---
title: "Field: notes"
published: true
priority: 3
rating: 4.5
empty: null
tags: [writing, "field work"]
authors:
  - name: Ada
    active: false
summary: |
  First line
  Second line
---
# Body
`;

  const result = parseFrontmatter(source);

  assert.equal(result.status, "parsed");
  if (result.status !== "parsed") return;
  assert.equal(result.body, "# Body\n");
  assert.equal(result.offsetLines, 14);
  assert.deepEqual(Object.fromEntries(result.entries.map(({ key, value }) => [key, value])), {
    title: "Field: notes",
    published: true,
    priority: 3,
    rating: 4.5,
    empty: null,
    tags: ["writing", "field work"],
    authors: [{ name: "Ada", active: false }],
    summary: "First line\nSecond line\n",
  });
});

test("comments, anchors, aliases, and empty frontmatter parse without losing key order", () => {
  const source = `---
# shared defaults
defaults: &defaults
  layout: note
copy: *defaults
---
Body`;

  const result = parseFrontmatter(source);

  assert.equal(result.status, "parsed");
  if (result.status !== "parsed") return;
  assert.deepEqual(result.entries, [
    { key: "defaults", value: { layout: "note" } },
    { key: "copy", value: { layout: "note" } },
  ]);
  assert.deepEqual(parseFrontmatter("---\n---\nBody"), {
    status: "parsed",
    entries: [],
    body: "Body",
    offsetLines: 2,
  });
});

test("malformed YAML fails open and reports its document position", () => {
  const source = `---
title: [unfinished
---
# Body`;

  const result = parseFrontmatter(source);

  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.body, source);
  assert.equal(result.offsetLines, 0);
  assert.equal(result.error.line, 3);
  assert.ok(result.error.column > 0);
  assert.match(result.error.message, /flow sequence|flow collection/i);
});

test("a non-mapping YAML root fails open", () => {
  const source = `---
- one
- two
---
Body`;

  const result = parseFrontmatter(source);

  assert.deepEqual(result, {
    status: "error",
    entries: [],
    body: source,
    offsetLines: 0,
    error: { message: "Frontmatter must be a YAML mapping.", line: 2, column: 1 },
  });
});

test("documents without a complete leading frontmatter block remain untouched", () => {
  assert.deepEqual(parseFrontmatter("# Plain\n\nBody"), {
    status: "none",
    entries: [],
    body: "# Plain\n\nBody",
    offsetLines: 0,
  });
  assert.deepEqual(parseFrontmatter("---\ntitle: unfinished"), {
    status: "none",
    entries: [],
    body: "---\ntitle: unfinished",
    offsetLines: 0,
  });
});

test("BOM and CRLF frontmatter keeps an exact body and source offset", () => {
  const result = parseFrontmatter("\uFEFF---\r\ntitle: Notes\r\n...\r\nBody\r\n");

  assert.equal(result.status, "parsed");
  if (result.status !== "parsed") return;
  assert.equal(result.body, "Body\r\n");
  assert.equal(result.offsetLines, 3);
  assert.deepEqual(result.entries, [{ key: "title", value: "Notes" }]);
});
