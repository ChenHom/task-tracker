import { resolve, sep } from 'node:path';

// ponytail: path-traversal guard for the static file server; swap for a real
// static-file middleware (e.g. express.static) once routing grows past this.
export function resolveSafePath(publicDir: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const filePath = resolve(publicDir, '.' + decoded);
  return filePath === publicDir || filePath.startsWith(publicDir + sep) ? filePath : null;
}
