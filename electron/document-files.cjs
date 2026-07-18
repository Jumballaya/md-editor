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

    async save(filePath, content) {
      if (typeof filePath !== "string" || typeof content !== "string") {
        return { status: "error", message: "Couldn't save the document (invalid request)." };
      }
      try {
        await writeFile(filePath, content, "utf8");
        return { status: "saved" };
      } catch (error) {
        return { status: "error", message: errorMessage("save", error) };
      }
    },

    async confirmUnsaved(owner, { canSave = false, title = "this document" } = {}) {
      const buttons = canSave ? ["Save", "Don't Save", "Cancel"] : ["Discard Changes", "Cancel"];
      const cancelId = buttons.length - 1;
      const result = await dialog.showMessageBox(owner, {
        type: "warning",
        title: "Unsaved changes",
        message: `Save changes to ${title || "this document"}?`,
        detail: canSave
          ? "Your edits have not been saved to disk."
          : "This document is not connected to a file on disk yet.",
        buttons,
        defaultId: 0,
        cancelId,
        noLink: true,
      });
      if (result.response === cancelId) return "cancel";
      if (canSave && result.response === 0) return "save";
      return "discard";
    },
  };
}

module.exports = { createDocumentFiles };
