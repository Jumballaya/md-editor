const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("desktopDocuments", {
  open: () => ipcRenderer.invoke("document:open"),
  openDroppedFile: (file) => ipcRenderer.invoke("document:open-path", webUtils.getPathForFile(file)),
  openRemote: (url) => ipcRenderer.invoke("document:open-remote", url),
  save: (request) => ipcRenderer.invoke("document:save", request),
  saveAs: (request) => ipcRenderer.invoke("document:save-as", request),
  confirmUnsaved: (request) => ipcRenderer.invoke("document:confirm-unsaved", request),
  confirmExternalChange: (request) => ipcRenderer.invoke("document:confirm-external-change", request),
  updateRecovery: (document) => ipcRenderer.invoke("document:recovery-update", document),
  restoreRecovery: () => ipcRenderer.invoke("document:recovery-restore"),
  rememberDocument: (document) => ipcRenderer.invoke("preferences:remember-document", document),
  restorePreviousDocument: () => ipcRenderer.invoke("preferences:restore-document"),
  watchLocal: (request) => ipcRenderer.send("document:watch", request),
  stopWatching: () => ipcRenderer.send("document:unwatch"),
  setCloseState: (state) => ipcRenderer.send("document:set-close-state", state),
  finishCloseSave: (saved) => ipcRenderer.send("document:finish-close-save", saved),
  onSaveBeforeClose(callback) {
    const listener = () => callback();
    ipcRenderer.on("document:save-before-close", listener);
    return () => ipcRenderer.removeListener("document:save-before-close", listener);
  },
  onExternalChange(callback) {
    const listener = (_event, change) => callback(change);
    ipcRenderer.on("document:external-change", listener);
    return () => ipcRenderer.removeListener("document:external-change", listener);
  },
  onMenuCommand(callback) {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on("application:command", listener);
    return () => ipcRenderer.removeListener("application:command", listener);
  },
});
