function commandItem(label, accelerator, command, dispatch) {
  return { label, accelerator, click: () => dispatch(command) };
}

function buildApplicationMenu({ appName, platform, dispatch, showAbout = () => {} }) {
  const template = [];

  if (platform === "darwin") {
    template.push({
      label: appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push({
    label: "File",
    submenu: [
      commandItem("New", "CmdOrCtrl+N", "new", dispatch),
      commandItem("Open…", "CmdOrCtrl+O", "open", dispatch),
      commandItem("Open URL…", "CmdOrCtrl+Shift+O", "open-url", dispatch),
      { type: "separator" },
      commandItem("Save", "CmdOrCtrl+S", "save", dispatch),
      commandItem("Save As…", "CmdOrCtrl+Shift+S", "save-as", dispatch),
      { type: "separator" },
      { role: platform === "darwin" ? "close" : "quit" },
    ],
  });
  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  });
  template.push({
    label: "View",
    submenu: [
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  });
  template.push({ role: "windowMenu" });
  if (platform !== "darwin") {
    template.push({
      label: "Help",
      submenu: [{ label: `About ${appName}`, click: showAbout }],
    });
  }

  return template;
}

function installApplicationMenu({ Menu, appName, platform, dispatch, showAbout }) {
  const template = buildApplicationMenu({ appName, platform, dispatch, showAbout });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildApplicationMenu, installApplicationMenu };
