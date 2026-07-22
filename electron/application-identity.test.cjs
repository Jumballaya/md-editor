const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const project = path.join(__dirname, "..");

test("package metadata and every desktop target use the application identity", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8"));

  assert.equal(packageJson.productName, "Markdown Editor");
  assert.equal(packageJson.build.appId, "com.jumballaya.mdeditor");
  assert.equal(packageJson.homepage, "https://github.com/Jumballaya/md-editor");
  assert.equal(packageJson.build.mac.icon, "build/icon.png");
  assert.equal(packageJson.build.win.icon, "build/icon.png");
  assert.equal(packageJson.build.linux.icon, "build/icon.png");
  assert.deepEqual(packageJson.build.extraResources, [{ from: "build/icon.png", to: "icon.png" }]);
});

test("the master icon is a transparent 1024-pixel PNG", () => {
  const icon = fs.readFileSync(path.join(project, "build", "icon.png"));

  assert.deepEqual(Array.from(icon.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 1024);
  assert.equal(icon.readUInt32BE(20), 1024);
  assert.equal(icon[25], 6);
});
