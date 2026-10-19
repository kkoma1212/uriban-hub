export function canonicalDevelopmentUrl(href: string, development: boolean): string | null {
  if (!development) return null;
  const url = new URL(href);
  if (url.hostname !== "127.0.0.1") return null;
  url.hostname = "localhost";
  return url.toString();
}
