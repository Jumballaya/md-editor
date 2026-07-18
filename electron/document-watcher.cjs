const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");

function createDocumentWatcher({
  onChange,
  watchDirectory = fs.watch,
  readFile = fsPromises.readFile,
  debounceMs = 180,
}) {
  let filePath = null;
  let fileName = null;
  let knownContent = null;
  let missing = false;
  let watcher = null;
  let timer = null;
  let lastError = null;

  function emitError(error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Couldn't watch the document (${detail}).`;
    if (message === lastError) return;
    lastError = message;
    onChange({ status: "error", path: filePath, message });
  }

  async function checkDisk(expectedPath) {
    if (!expectedPath || expectedPath !== filePath) return;
    let content;
    try {
      content = await readFile(expectedPath, "utf8");
    } catch (error) {
      if (expectedPath !== filePath) return;
      if (error?.code === "ENOENT") {
        if (!missing) onChange({ status: "missing", path: expectedPath });
        missing = true;
        lastError = null;
        return;
      }
      emitError(error);
      return;
    }
    if (expectedPath !== filePath) return;
    missing = false;
    lastError = null;
    if (content === knownContent) return;
    knownContent = content;
    onChange({ status: "changed", path: expectedPath, content });
  }

  function scheduleCheck() {
    if (timer) clearTimeout(timer);
    const expectedPath = filePath;
    timer = setTimeout(() => {
      timer = null;
      void checkDisk(expectedPath);
    }, debounceMs);
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    watcher?.close();
    watcher = null;
    filePath = null;
    fileName = null;
    knownContent = null;
    missing = false;
    lastError = null;
  }

  function update(request) {
    if (!request || typeof request.path !== "string" || !request.path || typeof request.content !== "string") {
      stop();
      onChange({ status: "error", path: null, message: "Couldn't watch the document (invalid request)." });
      return;
    }
    if (request.path === filePath && watcher) {
      knownContent = request.content;
      missing = false;
      lastError = null;
      return;
    }

    stop();
    filePath = request.path;
    fileName = path.basename(request.path);
    knownContent = request.content;
    try {
      watcher = watchDirectory(path.dirname(request.path), (_eventType, changedName) => {
        if (changedName && path.basename(String(changedName)) !== fileName) return;
        scheduleCheck();
      });
      watcher.on?.("error", emitError);
    } catch (error) {
      emitError(error);
    }
  }

  return { update, stop };
}

module.exports = { createDocumentWatcher };
