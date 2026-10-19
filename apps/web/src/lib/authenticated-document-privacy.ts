export function concealAuthenticatedDocument(): void {
  // Dialog portals live outside #root. Conceal the entire old document before
  // navigation or caching, including when a replacement is slow or unavailable.
  document.body.style.setProperty("display", "none", "important");
  document.body.setAttribute("inert", "");
}
