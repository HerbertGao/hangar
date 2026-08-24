import { createHash } from "node:crypto";

export interface VirtualCorpusEntry {
  readonly relativePath: string;
  readonly kind: "regular";
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export type VirtualToolResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: "invalid_path" | "not_found" | "invalid_query";
    };

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_ENTRIES = 256;
const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

const validPath = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 512 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value
    .split("/")
    .some((part) => part === "" || part === "." || part === "..");

/** Immutable, bounded, release-pinned regular-file corpus. */
export class VirtualCorpus {
  readonly #entries: ReadonlyMap<string, Uint8Array>;

  constructor(entries: readonly VirtualCorpusEntry[]) {
    if (entries.length > MAX_ENTRIES) throw new TypeError("corpus_too_large");
    let total = 0;
    const map = new Map<string, Uint8Array>();
    for (const entry of entries) {
      if (
        entry.kind !== "regular" ||
        !validPath(entry.relativePath) ||
        !HEX64.test(entry.digest) ||
        entry.bytes.byteLength > MAX_ENTRY_BYTES ||
        map.has(entry.relativePath) ||
        createHash("sha256").update(entry.bytes).digest("hex") !== entry.digest
      )
        throw new TypeError("invalid_virtual_corpus");
      total += entry.bytes.byteLength;
      if (total > MAX_TOTAL_BYTES) throw new TypeError("corpus_too_large");
      map.set(entry.relativePath, Uint8Array.from(entry.bytes));
    }
    this.#entries = new Map(
      [...map].sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  read(relativePath: string): VirtualToolResult<Uint8Array> {
    if (!validPath(relativePath)) return { ok: false, error: "invalid_path" };
    const bytes = this.#entries.get(relativePath);
    return bytes
      ? { ok: true, value: Uint8Array.from(bytes) }
      : { ok: false, error: "not_found" };
  }

  list(prefix = ""): VirtualToolResult<readonly string[]> {
    if (prefix !== "" && !validPath(prefix))
      return { ok: false, error: "invalid_path" };
    return {
      ok: true,
      value: [...this.#entries.keys()].filter((path) =>
        path.startsWith(prefix),
      ),
    };
  }

  search(
    query: string,
  ): VirtualToolResult<
    readonly { path: string; offsets: readonly number[] }[]
  > {
    if (
      query.length === 0 ||
      query.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(query)
    )
      return { ok: false, error: "invalid_query" };
    const needle = new TextEncoder().encode(query);
    const matches: { path: string; offsets: number[] }[] = [];
    for (const [path, bytes] of this.#entries) {
      const offsets: number[] = [];
      for (let index = 0; index <= bytes.length - needle.length; index += 1) {
        let same = true;
        for (let offset = 0; offset < needle.length; offset += 1)
          if (bytes[index + offset] !== needle[offset]) {
            same = false;
            break;
          }
        if (same) offsets.push(index);
      }
      if (offsets.length > 0) matches.push({ path, offsets });
    }
    return { ok: true, value: matches };
  }

  entries(): readonly VirtualCorpusEntry[] {
    return [...this.#entries].map(([relativePath, bytes]) => ({
      relativePath,
      kind: "regular" as const,
      bytes: Uint8Array.from(bytes),
      digest: createHash("sha256").update(bytes).digest("hex"),
    }));
  }
}
