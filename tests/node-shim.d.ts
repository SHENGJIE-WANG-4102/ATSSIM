// the project builds for the browser (no @types/node); the tests only need these calls
declare module 'node:fs' {
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function readFileSync(path: string): Uint8Array;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  export function renameSync(from: string, to: string): void;
  export function statSync(path: string): { isDirectory(): boolean };
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
}
declare module 'node:v8' {
  export function serialize(value: unknown): Uint8Array;
  export function deserialize(data: Uint8Array): unknown;
}
declare module 'node:crypto' {
  export function createHash(algorithm: string): { update(data: string | Uint8Array): void; digest(encoding: 'hex'): string };
}
declare module 'node:child_process' {
  export function spawn(command: string, args: string[], opts?: { stdio?: string }): {
    on(event: 'error', listener: (error: Error) => void): void;
    on(event: 'close', listener: (code: number | null) => void): void;
  };
}
declare const process: { env: Record<string, string | undefined>; argv: string[]; execPath: string };
