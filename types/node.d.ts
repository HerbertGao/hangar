declare const process: {
  readonly argv: string[];
  readonly execPath: string;
  readonly pid: number;
  readonly env: Record<string, string | undefined>;
  readonly stdin: {
    setEncoding(encoding: string): void;
    once(event: string, listener: (chunk: string) => void): void;
  };
  readonly stdout: { write(data: string): boolean };
  readonly stderr: { write(data: string): boolean };
  cwd(): string;
  exitCode?: number;
  send?: (message: unknown) => boolean;
  exit(code?: number): never;
  kill(pid: number, signal?: string | number): boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
};

declare module "node:crypto" {
  interface Hash {
    update(value: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
  export function randomUUID(): string;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    match(value: string, regexp: RegExp, message?: string): void;
    doesNotMatch(value: string, regexp: RegExp, message?: string): void;
    throws(block: () => unknown, expected?: unknown): void;
    rejects(
      block: Promise<unknown> | (() => Promise<unknown>),
      expected?: unknown,
    ): Promise<void>;
  };
  export default assert;
}

declare module "node:test" {
  interface TestContext {
    after(callback: () => void | Promise<void>): void;
  }
  type TestBody = (context: TestContext) => void | Promise<void>;
  const test: {
    (name: string, body: TestBody): void;
    (name: string, options: Record<string, unknown>, body: TestBody): void;
  };
  export default test;
}

declare module "node:sqlite" {
  export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }
  export class StatementSync {
    run(...values: unknown[]): RunResult;
    get(...values: unknown[]): Record<string, unknown> | undefined;
    all(...values: unknown[]): Record<string, unknown>[];
  }
  export class DatabaseSync {
    constructor(
      path: string,
      options?: { enableForeignKeyConstraints?: boolean },
    );
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export function backup(
    source: DatabaseSync,
    destination: string,
  ): Promise<void>;
}

declare module "node:fs" {
  export function readFileSync(path: string): Uint8Array;
  export function statSync(
    path: string,
    options: { bigint: true },
  ): { dev: bigint; ino: bigint };
}

declare module "node:fs/promises" {
  export function readFile(
    path: string | URL,
    encoding: "utf8",
  ): Promise<string>;
  export function writeFile(path: string | URL, data: string): Promise<void>;
  export function appendFile(path: string | URL, data: string): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
  export function stat(path: string): Promise<{ size: number }>;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:util" {
  export const types: {
    isProxy(value: unknown): boolean;
  };
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:events" {
  export function once(emitter: unknown, event: string): Promise<unknown[]>;
}

declare function setImmediate(callback: () => void): unknown;
declare function setInterval(
  callback: () => void,
  milliseconds: number,
): unknown;

declare module "node:child_process" {
  export interface ChildProcess {
    readonly pid?: number;
    readonly stdout: {
      on(event: string, listener: (chunk: Uint8Array) => void): void;
    } | null;
    readonly stderr: {
      on(event: string, listener: (chunk: Uint8Array) => void): void;
    } | null;
    readonly stdin: { write(data: string): boolean; end(): void } | null;
    kill(signal?: string): boolean;
    on(event: string, listener: (...args: unknown[]) => void): ChildProcess;
  }
  export function spawn(
    command: string,
    args?: readonly string[],
    options?: Record<string, unknown>,
  ): ChildProcess;
  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: Record<string, unknown>,
  ): {
    status: number | null;
    signal?: string;
    stdout?: string;
    stderr?: string;
    error?: Error;
  };
}
