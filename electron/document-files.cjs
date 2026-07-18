const fs = require("fs/promises");
const path = require("path");

const markdownFilters = [
  { name: "Markdown", extensions: ["md", "markdown", "mdx", "txt"] },
  { name: "All files", extensions: ["*"] },
];

function errorMessage(action, error) {
  const detail = error instanceof Error ? error.message : String(error);
  return `Couldn't ${action} the document (${detail}).`;
}

function suggestedFileName(title) {
  const base = path.basename(typeof title === "string" ? title : "Untitled").trim() || "Untitled";
  return /\.(md|markdown|mdx|txt)$/i.test(base) ? base : `${base}.md`;
}

function createDocumentFiles({ dialog, readFile = fs.readFile, writeFile = fs.writeFile }) {
  async function read(filePath) {
    try {
      const content = await readFile(filePath, "utf8");
      return {
        status: "opened",
        document: { path: filePath, name: path.basename(filePath), content },
      };
    } catch (error) {
      return { status: "error", message: errorMessage("open", error) };
    }
  }

  async function write(filePath, content) {
    if (typeof filePath !== "string" || typeof content !== "string") {
      return { status: "error", message: "Couldn't save the document (invalid request)." };
    }
    try {
      await writeFile(filePath, content, "utf8");
      return { status: "saved" };
    } catch (error) {
      return { status: "error", message: errorMessage("save", error) };
    }
  }

  return {
    async open(owner) {
      const result = await dialog.showOpenDialog(owner, {
        title: "Open Markdown document",
        properties: ["openFile"],
        filters: markdownFilters,
      });
      if (result.canceled || !result.filePaths[0]) return { status: "cancelled" };
      return read(result.filePaths[0]);
    },

    read,

    save: write,

    async saveAs(owner, { title, content } = {}) {
      if (typeof content !== "string") {
        return { status: "error", message: "Couldn't save the document (invalid request)." };
      }
      const result = await dialog.showSaveDialog(owner, {
        title: "Save Markdown document",
        defaultPath: suggestedFileName(title),
        filters: markdownFilters,
      });
      if (result.canceled || !result.filePath) return { status: "cancelled" };
      const saved = await write(result.filePath, content);
      if (saved.status === "error") return saved;
      return {
        status: "saved",
        document: { path: result.filePath, name: path.basename(result.filePath) },
      };
    },

    async confirmUnsaved(owner, { title = "this document" } = {}) {
      const result = await dialog.showMessageBox(owner, {
        type: "warning",
        title: "Unsaved changes",
        message: `Save changes to ${title || "this document"}?`,
        detail: "Your edits have not been saved to disk.",
        buttons: ["Save", "Don't Save", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (result.response === 2) return "cancel";
      if (result.response === 0) return "save";
      return "discard";
    },

    async confirmExternalChange(owner, { title = "This document" } = {}) {
      const result = await dialog.showMessageBox(owner, {
        type: "warning",
        title: "Document changed on disk",
        message: `${title || "This document"} also changed outside Markdown Editor`,
        detail: "Save a copy to preserve both versions, or explicitly choose which version should replace the other.",
        buttons: ["Save a Copy…", "Overwrite Disk", "Reload from Disk", "Cancel"],
        defaultId: 0,
        cancelId: 3,
        noLink: true,
      });
      return ["save-copy", "overwrite", "reload", "cancel"][result.response] || "cancel";
    },
  };
}

module.exports = { createDocumentFiles };
