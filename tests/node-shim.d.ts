// the project builds for the browser (no @types/node); the tests only need these two calls
declare module 'node:fs' {
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function writeFileSync(path: string, data: string): void;
}
