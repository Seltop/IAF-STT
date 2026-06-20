export function appPath(pathname: string): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${appBasePath()}${path}`;
}

function appBasePath(): string {
  const base = import.meta.env.BASE_URL || "/";
  const normalized = base.replace(/\/+$/g, "");
  return normalized === "" ? "" : normalized;
}
