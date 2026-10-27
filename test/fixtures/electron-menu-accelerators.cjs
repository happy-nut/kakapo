// Prints every accelerator a list of Electron menu ROLES expands to. The roles are read out of the built
// main process by the test, so this fixture never carries a second copy of which roles the app uses — it
// only answers the one question no source file can: what `role: "appMenu"` actually binds. (Hide Others
// is ⌘⌥H, and nothing in kakapo's own code says so.)
const { app, Menu } = require("electron");

const roles = JSON.parse(process.argv[2] || "[]");
// Accelerators the app DRAWS but does not register (registerAccelerator: false). Built here so that an
// accelerator Electron cannot parse fails this fixture instead of throwing inside the real menu bar.
const drawn = JSON.parse(process.argv[3] || "[]");

app.whenReady().then(() => {
  const out = [];
  const walk = (items) => items.forEach((item) => {
    if (item.accelerator) out.push({ role: item.role || null, label: item.label || "", accelerator: item.accelerator });
    if (item.submenu) walk(item.submenu.items);
  });
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(roles.map((role) => ({ role }))));
    walk(Menu.getApplicationMenu().items);
    // The drawn ones go into a menu of their own: buildFromTemplate is where an unparseable
    // accelerator throws, and `registerAccelerator: false` is the claim being checked — the item
    // keeps its accelerator text and Electron reports it without having taken the key.
    const drawnMenu = Menu.buildFromTemplate(drawn.map((accelerator, i) => ({
      label: "drawn" + i, accelerator, registerAccelerator: false, click: () => {},
    })));
    const drawnOut = drawnMenu.items.map((item) => ({ accelerator: item.accelerator, registered: item.registerAccelerator }));
    console.log("KAKAPO_MENU_ACCELERATORS=" + JSON.stringify(out));
    console.log("KAKAPO_MENU_DRAWN=" + JSON.stringify(drawnOut));
  } catch (error) {
    console.error(String((error && error.stack) || error));
    app.exit(1);
    return;
  }
  app.quit();
});
