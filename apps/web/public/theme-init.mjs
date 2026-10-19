/* global document, window */

(() => {
  const storageKey = "classhub:appearance";
  const darkMediaQuery = "(prefers-color-scheme: dark)";
  const allowed = new Set(["system", "light", "dark"]);
  let preference = "system";

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (allowed.has(stored)) preference = stored;
  } catch {
    // System appearance remains the safe default when browser storage is unavailable.
  }

  const systemDark =
    typeof window.matchMedia === "function" && window.matchMedia(darkMediaQuery).matches;
  const resolved = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  const root = document.documentElement;
  root.setAttribute("data-appearance", preference);
  root.setAttribute("data-theme", resolved);

  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor !== null) {
    themeColor.setAttribute("content", resolved === "dark" ? "#11131d" : "#efe8dc");
  }
})();
