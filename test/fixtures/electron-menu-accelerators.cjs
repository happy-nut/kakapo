const { app, Menu } = require("electron");

const roles = JSON.parse(process.argv[2] || "[]");
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
