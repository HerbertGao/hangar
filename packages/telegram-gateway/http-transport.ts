import type { RawTelegramUpdate, TelegramTransport } from "./index.ts";
import type { ControlCommandConnector } from "../control-core/index.ts";

export interface TelegramProtocolMapper {
  normalize(
    update: Readonly<Record<string, unknown>>,
  ): Omit<RawTelegramUpdate, "updateId" | "rawBytes">;
  delivery(
    input: Parameters<ControlCommandConnector>[0],
  ): Readonly<Record<string, unknown>>;
}

export class TelegramHttpTransport implements TelegramTransport {
  readonly #baseUrl: string;
  readonly #mapper: TelegramProtocolMapper;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: {
    baseUrl: string;
    mapper: TelegramProtocolMapper;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#mapper = options.mapper;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  async poll(botToken: string, cursor: string | null, limit: number) {
    const payload = await this.#call(botToken, "getUpdates", {
      ...(cursor ? { offset: Number(cursor) } : {}),
      limit,
      timeout: 0,
    });
    if (!Array.isArray(payload.result))
      throw new Error("telegram_malformed_result");
    const updates = payload.result.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("telegram_malformed_update");
      const record = raw as Readonly<Record<string, unknown>>;
      if (!Number.isSafeInteger(record.update_id))
        throw new Error("telegram_malformed_update_id");
      const rawBytes = new TextEncoder().encode(JSON.stringify(record));
      return {
        updateId: String(record.update_id),
        rawBytes,
        ...this.#mapper.normalize(record),
      };
    });
    const next = updates.reduce(
      (maximum, update) => Math.max(maximum, Number(update.updateId) + 1),
      cursor ? Number(cursor) : 0,
    );
    return { updates, nextCursor: next > 0 ? String(next) : cursor };
  }

  async deliver(
    botToken: string,
    input: Parameters<ControlCommandConnector>[0],
  ): Promise<"committed" | "not-committed"> {
    const method =
      input.deliveryOperation === "send-message"
        ? "sendMessage"
        : input.deliveryOperation === "edit-message"
          ? "editMessageText"
          : input.deliveryOperation === "answer-callback"
            ? "answerCallbackQuery"
            : undefined;
    if (!method) throw new Error("telegram_unknown_delivery_operation");
    const result = await this.#call(
      botToken,
      method,
      this.#mapper.delivery(input),
    );
    return result.ok === true ? "committed" : "not-committed";
  }

  async #call(
    botToken: string,
    method: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const response = await this.#fetch(
      `${this.#baseUrl}/bot${encodeURIComponent(botToken)}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      },
    );
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("telegram_malformed_json");
    }
    if (
      !response.ok ||
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    )
      throw new Error("telegram_transport_failure");
    return parsed as Readonly<Record<string, unknown>>;
  }
}
