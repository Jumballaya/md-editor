const { app, BrowserWindow, dialog, ipcMain, net, shell } = require("electron");
const path = require("path");
const { createDocumentFiles } = require("./document-files.cjs");
const { createDocumentRecovery } = require("./document-recovery.cjs");
const { createRemoteDocuments } = require("./remote-documents.cjs");

const documentFiles = createDocumentFiles({ dialog });
const remoteDocuments = createRemoteDocuments({ fetch: (url, options) => net.fetch(url, options) });

function ownerFor(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

ipcMain.handle("document:open", (event) => documentFiles.open(ownerFor(event)));
ipcMain.handle("document:open-path", (_event, filePath) => documentFiles.read(filePath));
ipcMain.handle("document:save", (_event, request) => documentFiles.save(request?.path, request?.content));
ipcMain.handle("document:save-as", (event, request) => documentFiles.saveAs(ownerFor(event), request));
ipcMain.handle("document:open-remote", (_event, url) => remoteDocuments.open(url));
ipcMain.handle("document:confirm-unsaved", (event, request) => documentFiles.confirmUnsaved(ownerFor(event), request));

function createWindow(documentRecovery) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 420,
    backgroundColor: "#0d1117",
    title: "Markdown Editor",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const closeState = { dirty: false, title: "this document", allowed: false, prompting: false };

  const updateCloseState = (event, state) => {
    if (event.sender !== win.webContents) return;
    closeState.dirty = state?.dirty === true;
    closeState.title = typeof state?.title === "string" ? state.title : "this document";
    if (process.platform === "darwin") win.setDocumentEdited(closeState.dirty);
  };
  const closeWithoutRecovery = async () => {
    await documentRecovery.discard();
    if (win.isDestroyed()) return;
    closeState.allowed = true;
    win.close();
  };
  const finishCloseSave = (event, saved) => {
    if (event.sender !== win.webContents) return;
    closeState.prompting = false;
    if (saved !== true) return;
    closeState.prompting = true;
    void closeWithoutRecovery();
  };
  ipcMain.on("document:set-close-state", updateCloseState);
  ipcMain.on("document:finish-close-save", finishCloseSave);

  win.on("close", async (event) => {
    if (closeState.allowed || !closeState.dirty) return;
    event.preventDefault();
    if (closeState.prompting) return;
    closeState.prompting = true;
    const choice = await documentFiles.confirmUnsaved(win, closeState);
    closeState.prompting = false;
    if (choice === "cancel") return;
    if (choice === "save") {
      closeState.prompting = true;
      win.webContents.send("document:save-before-close");
      return;
    }
    void closeWithoutRecovery();
  });
  win.on("closed", () => {
    ipcMain.removeListener("document:set-close-state", updateCloseState);
    ipcMain.removeListener("document:finish-close-save", finishCloseSave);
  });

  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));

  // Open http(s) links (markdown links, target=_blank) in the user's browser
  // instead of navigating the app window away from the editor.
  const openExternal = (url) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return true;
    }
    return false;
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (openExternal(url)) e.preventDefault();
  });
}

app.whenReady().then(() => {
  const documentRecovery = createDocumentRecovery({
    filePath: path.join(app.getPath("userData"), "document-recovery.json"),
    dialog,
  });
  ipcMain.handle("document:recovery-update", (_event, document) => documentRecovery.update(document));
  ipcMain.handle("document:recovery-restore", (event) => documentRecovery.restore(ownerFor(event)));

  createWindow(documentRecovery);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(documentRecovery);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
