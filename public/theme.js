// Runs before first paint (a plain, blocking script in <head>): puts the theme chosen with the footer's
// theme button on <html>, so the page never shows the system's theme first. No choice means System.
// The choice stays on this device (localStorage), like route.bible's; it isn't part of the library.
try {
  const theme = localStorage.getItem("selah-vault:theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {}
