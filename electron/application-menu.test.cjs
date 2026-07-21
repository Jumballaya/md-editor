const assert = require("node:assert/strict");
const test = require("node:test");
const { buildApplicationMenu, installApplicationMenu } = require("./application-menu.cjs");

function menuNamed(template, label) {
  return template.find((menu) => menu.label === label);
}

test("file menu dispatches every document command with a native accelerator", () => {
  const commands = [];
  const template = buildApplicationMenu({
    appName: "Markdown Editor",
    platform: "linux",
    dispatch: (command) => commands.push(command),
  });
  const items = menuNamed(template, "File").submenu.filter((item) => item.click);

  assert.deepEqual(items.map(({ label, accelerator }) => [label, accelerator]), [
    ["New", "CmdOrCtrl+N"],
    ["Open…", "CmdOrCtrl+O"],
    ["Open URL…", "CmdOrCtrl+Shift+O"],
    ["Save", "CmdOrCtrl+S"],
    ["Save As…", "CmdOrCtrl+Shift+S"],
  ]);
  items.forEach((item) => item.click());
  assert.deepEqual(commands, ["new", "open", "open-url", "save", "save-as"]);
});

test("platform conventions determine the application and exit menus", () => {
  const mac = buildApplicationMenu({ appName: "Markdown Editor", platform: "darwin", dispatch() {} });
  const windows = buildApplicationMenu({ appName: "Markdown Editor", platform: "win32", dispatch() {} });

  assert.equal(mac[0].label, "Markdown Editor");
  assert.equal(menuNamed(mac, "File").submenu.at(-1).role, "close");
  assert.equal(menuNamed(windows, "File").submenu.at(-1).role, "quit");
  assert.equal(menuNamed(mac, "Edit").submenu[0].role, "undo");
  assert.equal(menuNamed(mac, "Edit").submenu[1].role, "redo");
});

test("install builds and applies the native menu", () => {
  let builtTemplate;
  let installedMenu;
  const Menu = {
    buildFromTemplate(template) {
      builtTemplate = template;
      return { template };
    },
    setApplicationMenu(menu) {
      installedMenu = menu;
    },
  };

  installApplicationMenu({ Menu, appName: "Markdown Editor", platform: "linux", dispatch() {} });

  assert.equal(menuNamed(builtTemplate, "File").label, "File");
  assert.deepEqual(installedMenu, { template: builtTemplate });
});
