// The footer's theme button, as route.bible has it: one square icon showing the theme in use; a tap
// switches to the other one and keeps that choice on this device. Until it's tapped the page follows the
// system's light or dark setting (System), and so does every new device. /theme.js applies a kept choice
// before first paint.

export const THEME_KEY = "selah-vault:theme";

/** A kept choice, or null for System. */
export const storedTheme = (storage) => {
  try {
    const t = storage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
};

/** The theme on screen: the kept choice, else the system's. */
export const shownTheme = (stored, systemDark) => stored ?? (systemDark ? "dark" : "light");

/** What a tap switches to. */
export const flipped = (theme) => (theme === "light" ? "dark" : "light");

const SUN =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.2"/><path d="M12 19.8V22"/><path d="m4.93 4.93 1.56 1.56"/><path d="m17.51 17.51 1.56 1.56"/><path d="M2 12h2.2"/><path d="M19.8 12H22"/><path d="m4.93 19.07 1.56-1.56"/><path d="m17.51 6.49 1.56-1.56"/></svg>';
const MOON =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/></svg>';

/**
 * Wires the buttons. onChange(theme) hears every change of the theme on screen (a tap, or the system
 * switching while no choice is kept), for parts that theme themselves, like a passage's text.
 */
export function setupThemeToggle(buttons, { onChange = () => {} } = {}) {
  const system = matchMedia("(prefers-color-scheme: dark)");
  const shown = () => shownTheme(storedTheme(localStorage), system.matches);
  const paint = () => {
    const theme = shown();
    const next = flipped(theme);
    for (const button of buttons) {
      button.dataset.theme = theme;
      // Menu rows show icon + current theme name; footer chips stay icon-only.
      if (button.classList.contains("menu-theme")) {
        const label = theme === "dark" ? "Dark theme" : "Light theme";
        button.innerHTML = `${theme === "dark" ? MOON : SUN}<span class="menu-theme-label">${label}</span>`;
      } else {
        button.innerHTML = theme === "dark" ? MOON : SUN;
      }
      button.setAttribute("aria-label", `Switch to ${next} mode`);
      button.title = `Switch to ${next} mode`;
    }
  };
  const tap = () => {
    const next = flipped(shown());
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    document.documentElement.dataset.theme = next;
    paint();
    onChange(next);
  };
  for (const button of buttons) button.addEventListener("click", tap);
  system.addEventListener("change", () => {
    if (storedTheme(localStorage)) return;
    paint();
    onChange(shown());
  });
  paint();
  return shown;
}
