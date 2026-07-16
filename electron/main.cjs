const { app, BrowserWindow, shell } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 420,
    backgroundColor: "#0d1117",
    title: "Markdown Editor",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
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
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
