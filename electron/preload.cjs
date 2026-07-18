const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("desktopDocuments", {
  open: () => ipcRenderer.invoke("document:open"),
  openDroppedFile: (file) => ipcRenderer.invoke("document:open-path", webUtils.getPathForFile(file)),
  openRemote: (url) => ipcRenderer.invoke("document:open-remote", url),
  save: (request) => ipcRenderer.invoke("document:save", request),
  saveAs: (request) => ipcRenderer.invoke("document:save-as", request),
  confirmUnsaved: (request) => ipcRenderer.invoke("document:confirm-unsaved", request),
  setCloseState: (state) => ipcRenderer.send("document:set-close-state", state),
  finishCloseSave: (saved) => ipcRenderer.send("document:finish-close-save", saved),
  onSaveBeforeClose(callback) {
    const listener = () => callback();
    ipcRenderer.on("document:save-before-close", listener);
    return () => ipcRenderer.removeListener("document:save-before-close", listener);
  },
});
