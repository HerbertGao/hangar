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

declare function setTimeout(
  callback: (...args: unknown[]) => void,
  milliseconds: number,
): unknown;
declare function clearTimeout(handle: unknown): void;

declare interface TextDecoderConstructor {
  new (label?: string, options?: { fatal?: boolean }): TextDecoder;
}
declare interface TextDecoder {
  decode(input?: Uint8Array): string;
}
declare var TextDecoder: TextDecoderConstructor;

declare module "node:crypto" {
  interface Hash {
    update(value: string | Uint8Array): Hash;
    digest(encoding: "hex" | "base64url"): string;
    digest(): Uint8Array;
  }
  export function createHash(algorithm: string): Hash;
  export function createHmac(algorithm: string, key: string | Uint8Array): Hash;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
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

declare module "node:buffer" {
  export class Buffer extends Uint8Array {
    static from(
      value: string | readonly number[] | Uint8Array | ArrayBuffer,
      encoding?: string,
    ): Buffer;
    static byteLength(value: string | Uint8Array): number;
    static concat(list: readonly Uint8Array[]): Buffer;
    toString(encoding?: string): string;
  }
}

declare module "node:net" {
  export interface Socket {
    write(data: string): boolean;
    end(data?: string): void;
    destroy(): void;
    on(event: string, listener: (data?: Uint8Array | Error) => void): void;
  }
  export function connect(port: number, host?: string): Socket;
}

declare interface ResponseHeaders {
  get(name: string): string | null;
}
declare interface FetchResponse {
  status: number;
  headers: ResponseHeaders;
  text(): Promise<string>;
}
declare function fetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: unknown;
  },
): Promise<FetchResponse>;

declare module "node:http" {
  export interface IncomingMessage {
    readonly method?: string;
    readonly url?: string;
    readonly rawHeaders: string[];
    readonly socket: { destroy(): void };
    on(event: "data", listener: (chunk: Uint8Array) => void): void;
    on(event: "end", listener: () => void): void;
    on(event: "error" | "aborted", listener: (error?: Error) => void): void;
    destroy(error?: Error): void;
    resume(): void;
  }
  export interface ServerResponse {
    writeHead(
      status: number,
      headers?: Record<string, string | readonly string[]>,
    ): void;
    write(body: string): boolean;
    end(body?: string): void;
    destroy(): void;
    on(event: "close", listener: () => void): void;
  }
  export interface Server {
    listen(port: number, callback?: () => void): Server;
    close(callback?: () => void): void;
    address(): { port: number } | null;
    on(
      event: "connection",
      listener: (socket: {
        destroy(): void;
        on(event: string, listener: () => void): void;
      }) => void,
    ): Server;
  }
  export function createServer(
    handler?: (request: IncomingMessage, response: ServerResponse) => void,
  ): Server;
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
