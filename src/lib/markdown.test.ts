import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdownMarkup } from "./markdown";

test("remote Markdown resolves relative images and links against its fetched URL", () => {
  const html = renderMarkdownMarkup(
    [
      "![Diagram](./images/diagram.png)",
      "",
      "[Details](../guide.md)",
    ].join("\n"),
    "https://example.com/docs/notes/readme.md",
  );

  assert.match(html, /src="https:\/\/example\.com\/docs\/notes\/images\/diagram\.png"/);
  assert.match(html, /href="https:\/\/example\.com\/docs\/guide\.md"/);
});

test("remote Markdown leaves absolute and in-document references alone", () => {
  const html = renderMarkdownMarkup(
    [
      "![Hosted](https://cdn.example.com/diagram.png)",
      "",
      "[Section](#details)",
    ].join("\n"),
    "https://example.com/docs/readme.md",
  );

  assert.match(html, /src="https:\/\/cdn\.example\.com\/diagram\.png"/);
  assert.match(html, /href="#details"/);
});

test("GitHub raw documents keep images raw and open relative links on GitHub", () => {
  const html = renderMarkdownMarkup(
    [
      "![Diagram](./images/diagram.png)",
      "",
      "[Guide](../guide.md)",
    ].join("\n"),
    "https://raw.githubusercontent.com/acme/docs/revision/articles/readme.md",
  );

  assert.match(html, /src="https:\/\/raw\.githubusercontent\.com\/acme\/docs\/revision\/articles\/images\/diagram\.png"/);
  assert.match(html, /href="https:\/\/github\.com\/acme\/docs\/blob\/revision\/guide\.md"/);
});
