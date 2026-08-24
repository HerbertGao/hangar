import { createHash } from "node:crypto";

import { digestJson } from "../contracts/index.ts";
import type {
  ControlCommandDeliveryInput,
  Result,
  TelegramDeliveryView,
  TelegramGatewayPort,
} from "../contracts/index.ts";
import {
  commandMeta,
  controlDeliveryIdempotencyKey,
  normalizeControlDeliveryInput,
  type ControlCommandConnector,
  type EffectGateway,
} from "../control-core/index.ts";
import {
  type CONTROL_OPERATIONS,
  TELEGRAM_GATEWAY_PORT_SCHEMAS,
  deriveDeliveryKey,
  deriveUpdateOccurrenceKey,
  signUpdateInteractionRef,
  verifyControlInteractionRef,
  verifyUpdateInteractionRef,
} from "../control-api/index.ts";

export interface RawTelegramUpdate {
  readonly updateId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly messageIdOrCallbackId: string | null;
  readonly mappingVersion: number;
  readonly controlOperation: (typeof CONTROL_OPERATIONS)[number];
  readonly normalizedTarget: string;
  readonly rawBytes: Uint8Array;
}

export interface TelegramTransport {
  poll(
    botToken: string,
    cursor: string | null,
    limit: number,
  ): Promise<{
    updates: readonly RawTelegramUpdate[];
    nextCursor: string | null;
  }>;
  deliver(
    botToken: string,
    input: Parameters<ControlCommandConnector>[0],
  ): Promise<"committed" | "not-committed">;
}

export interface TelegramConnectorOptions {
  readonly connectorInstanceId: string;
  readonly adapterInstanceId: string;
  readonly serviceAuthorityRef: string;
  readonly serviceAuthorityId: string;
  readonly serviceCredentialGeneration: number;
  readonly updateRefSecret: string;
  readonly controlRefSecret: string;
  readonly nowUnixMs: () => number;
  readonly updateRefTtlMs?: number;
}

const ROUTE_FOR_OPERATION: Readonly<
  Record<(typeof CONTROL_OPERATIONS)[number], string>
> = {
  "submit-intent": "intent.submit",
  "read-run": "runs.read",
  "cancel-run": "runs.cancel",
  "decide-approval": "approvals.decide",
};

const hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const safePayload = (bytes: Uint8Array): boolean => {
  if (bytes.byteLength > 16_384) return false;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return ![...text].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 && character !== "\n" && character !== "\t";
    });
  } catch {
    return false;
  }
};

/** Gateway-owned connector. Bot token never appears in the public port. */
export class TelegramTransportConnector implements TelegramGatewayPort {
  readonly #gateway: EffectGateway;
  readonly #transport: TelegramTransport;
  readonly #botToken: string;
  readonly #options: TelegramConnectorOptions;

  constructor(
    gateway: EffectGateway,
    transport: TelegramTransport,
    botToken: string,
    options: TelegramConnectorOptions,
  ) {
    if (botToken.length === 0) throw new TypeError("missing_bot_token");
    this.#gateway = gateway;
    this.#transport = transport;
    this.#botToken = botToken;
    this.#options = options;
  }

  async pollUpdates(input: {
    serviceAuthorityRef: string;
    cursor: string | null;
    limit: number;
  }) {
    const parsed =
      TELEGRAM_GATEWAY_PORT_SCHEMAS.pollUpdates.request.parse(input);
    this.#assertService(parsed.serviceAuthorityRef);
    const polled = await this.#transport.poll(
      this.#botToken,
      parsed.cursor,
      parsed.limit,
    );
    const updates = polled.updates.map((update) => {
      const rawUpdateDigest = hex(update.rawBytes);
      const updateOccurrenceKey = deriveUpdateOccurrenceKey(
        this.#options.connectorInstanceId,
        this.#options.serviceAuthorityId,
        update.updateId,
      );
      const claims = {
        schemaVersion: "telegram-update-ref-v1" as const,
        connectorInstanceId: this.#options.connectorInstanceId,
        adapterInstanceId: this.#options.adapterInstanceId,
        serviceAuthorityId: this.#options.serviceAuthorityId,
        serviceCredentialGeneration: this.#options.serviceCredentialGeneration,
        updateId: update.updateId,
        updateOccurrenceKey,
        userId: update.userId,
        chatId: update.chatId,
        messageIdOrCallbackId: update.messageIdOrCallbackId,
        mappingVersion: update.mappingVersion,
        controlOperation: update.controlOperation,
        normalizedTarget: update.normalizedTarget,
        rawUpdateDigest,
        expiryUnixMs:
          this.#options.nowUnixMs() +
          (this.#options.updateRefTtlMs ?? 5 * 60_000),
      };
      return {
        rawUpdate: update.rawBytes,
        updateInteractionRef: signUpdateInteractionRef(
          claims,
          this.#options.updateRefSecret,
        ),
      };
    });
    return TELEGRAM_GATEWAY_PORT_SCHEMAS.pollUpdates.response.parse({
      updates,
      nextCursor: polled.nextCursor,
    });
  }

  async requestDelivery(input: {
    serviceAuthorityRef: string;
    updateInteractionRef: string;
    controlInteractionRef: string;
    responseKind: string;
    deliveryKey: string;
    deliveryOperation: string;
    payloadBytes: Uint8Array;
    payloadDigest: string;
  }) {
    const parsed =
      TELEGRAM_GATEWAY_PORT_SCHEMAS.requestDelivery.request.parse(input);
    this.#assertService(parsed.serviceAuthorityRef);
    const now = this.#options.nowUnixMs();
    const update = verifyUpdateInteractionRef(
      parsed.updateInteractionRef,
      this.#options.updateRefSecret,
      now,
    );
    const interaction = verifyControlInteractionRef(
      parsed.controlInteractionRef,
      this.#options.controlRefSecret,
      now,
    );
    if (!update.ok || !interaction.ok)
      return { status: "denied" as const, error: "forbidden" as const };
    const updateRefDigest = hex(parsed.updateInteractionRef);
    const controlRefDigest = hex(parsed.controlInteractionRef);
    if (
      interaction.claims.updateInteractionRefDigest !== updateRefDigest ||
      interaction.claims.normalizedTarget !== update.claims.normalizedTarget ||
      interaction.claims.responseKind !== parsed.responseKind ||
      interaction.claims.routeId !==
        ROUTE_FOR_OPERATION[update.claims.controlOperation] ||
      parsed.deliveryKey !==
        deriveDeliveryKey(
          controlRefDigest,
          parsed.deliveryOperation,
          parsed.responseKind,
        ) ||
      !safePayload(parsed.payloadBytes) ||
      hex(parsed.payloadBytes) !== parsed.payloadDigest
    )
      return { status: "denied" as const, error: "forbidden" as const };

    const claimsDigest = digestJson(update.claims);
    const command: ControlCommandDeliveryInput = {
      connectorInstanceId: update.claims.connectorInstanceId,
      serviceAuthorityId: update.claims.serviceAuthorityId,
      updateId: update.claims.updateId,
      updateOccurrenceKey: update.claims.updateOccurrenceKey,
      claimsDigest,
      rawUpdateDigest: update.claims.rawUpdateDigest,
      controlInteractionIdentity: controlRefDigest,
      deliveryKey: parsed.deliveryKey,
      deliveryGeneration: interaction.claims.macKeyGeneration,
      mappingVersion: update.claims.mappingVersion,
      target: interaction.claims.normalizedTarget,
      deliveryOperation: parsed.deliveryOperation,
      responseKind: parsed.responseKind,
      payloadBytes: parsed.payloadBytes,
      payloadDigest: parsed.payloadDigest,
    };
    const meta = commandMeta(
      "telegram-service",
      "request-control-delivery",
      command.controlInteractionIdentity,
      controlDeliveryIdempotencyKey(command.updateOccurrenceKey),
      normalizeControlDeliveryInput(command),
      null,
      hex(parsed.serviceAuthorityRef),
    );
    const result = this.#gateway.requestControlDelivery(meta, command);
    return result.ok
      ? result.value
      : { status: "denied" as const, error: result.error };
  }

  async readDelivery(input: {
    serviceAuthorityRef: string;
    effectId: string;
  }): Promise<TelegramDeliveryView> {
    const parsed =
      TELEGRAM_GATEWAY_PORT_SCHEMAS.readDelivery.request.parse(input);
    this.#assertService(parsed.serviceAuthorityRef);
    const result = this.#gateway.readControlDelivery(parsed.effectId);
    if (!result.ok || result.value.status !== "effect")
      throw new Error(result.ok ? "invalid_delivery" : result.error);
    return {
      effectId: parsed.effectId,
      state: result.value.state,
      sanitizedSummary: result.value.outcome ?? null,
    };
  }

  /** Gateway worker; not part of adapter-facing TelegramGatewayPort. */
  dispatch(
    meta: Parameters<EffectGateway["dispatchControl"]>[0],
    effectId: string,
  ): Promise<Result<null>> {
    return this.#gateway.dispatchControl(meta, effectId, (delivery) =>
      this.#transport.deliver(this.#botToken, delivery),
    );
  }

  #assertService(value: string): void {
    if (value !== this.#options.serviceAuthorityRef)
      throw new TypeError("invalid_service_authority");
  }
}
