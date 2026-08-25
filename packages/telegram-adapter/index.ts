import { createHash } from "node:crypto";

import type { TelegramGatewayPort } from "../contracts/index.ts";
import {
  type ControlSdk,
  decodeUpdateInteractionClaims,
  deriveDeliveryKey,
  deriveTelegramIdempotencyKey,
} from "../control-sdk/index.ts";
import type {
  TelegramTransportStore,
  TelegramTransportRecord,
} from "../telegram-transport-store-sqlite/index.ts";

export type MappedControlRequest =
  | { readonly kind: "run"; readonly runId: string }
  | {
      readonly kind: "intent";
      readonly agentId: string;
      readonly intentId: string;
      readonly descriptorVersion: number;
      readonly executionMode: "shadow-evaluator" | "production";
      readonly input: Readonly<
        Record<string, string | number | boolean | null>
      >;
      readonly ifMatch: string;
    }
  | {
      readonly kind: "cancel";
      readonly runId: string;
      readonly ifMatch: string;
    }
  | {
      readonly kind: "decision";
      readonly runId: string;
      readonly approvalId: string;
      readonly decision: "approved" | "denied";
      readonly ifMatch: string;
    };

export type TelegramControlSdk = Pick<
  ControlSdk,
  "getRun" | "submitIntent" | "cancelRun" | "decideApproval"
>;

export interface TelegramControlMapper {
  map(input: {
    readonly claims: ReturnType<typeof decodeUpdateInteractionClaims>;
    readonly rawUpdate: Uint8Array;
  }): Promise<MappedControlRequest> | MappedControlRequest;
}

export interface TelegramAdapterOptions {
  readonly serviceAuthorityRef: string;
  readonly nowUnixMs: () => number;
  readonly mappingValid: (
    claims: ReturnType<typeof decodeUpdateInteractionClaims>,
  ) => boolean;
  readonly unknownExpiryMs?: number;
  readonly pollLimit?: number;
}

const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const RESPONSE_KIND = {
  run: "run-viewed",
  intent: "intent-admitted",
  cancel: "cancel-requested",
  decision: "decision-recorded",
} as const;

const DELIVERY_OPERATION: Readonly<
  Record<
    MappedControlRequest["kind"],
    "send-message" | "edit-message" | "answer-callback"
  >
> = {
  run: "edit-message",
  intent: "send-message",
  cancel: "edit-message",
  decision: "answer-callback",
};

export class TelegramLongPollingAdapter {
  readonly #sdk: TelegramControlSdk;
  readonly #port: TelegramGatewayPort;
  readonly #store: TelegramTransportStore;
  readonly #mapper: TelegramControlMapper;
  readonly #options: TelegramAdapterOptions;

  constructor(
    sdk: TelegramControlSdk,
    port: TelegramGatewayPort,
    store: TelegramTransportStore,
    mapper: TelegramControlMapper,
    options: TelegramAdapterOptions,
  ) {
    this.#sdk = sdk;
    this.#port = port;
    this.#store = store;
    this.#mapper = mapper;
    this.#options = options;
  }

  async pollOnce(): Promise<void> {
    const polled = await this.#port.pollUpdates({
      serviceAuthorityRef: this.#options.serviceAuthorityRef,
      cursor: this.#store.cursor(),
      limit: Math.min(this.#options.pollLimit ?? 100, 100),
    });
    for (const update of polled.updates) {
      let claims: ReturnType<typeof decodeUpdateInteractionClaims>;
      try {
        claims = decodeUpdateInteractionClaims(update.updateInteractionRef);
      } catch {
        continue;
      }
      this.#store.registerUpdate({
        occurrenceKey: claims.updateOccurrenceKey,
        updateRef: update.updateInteractionRef,
        rawUpdate: update.rawUpdate,
      });
    }
    this.#store.setCursor(polled.nextCursor);
    await this.resume();
  }

  async resume(): Promise<void> {
    for (const record of this.#store.work()) {
      let claims: ReturnType<typeof decodeUpdateInteractionClaims>;
      try {
        claims = decodeUpdateInteractionClaims(record.updateRef);
      } catch {
        this.#store.quarantineUnknown(record.occurrenceKey);
        continue;
      }
      if (
        claims.expiryUnixMs <= this.#options.nowUnixMs() ||
        !this.#options.mappingValid(claims)
      ) {
        if (record.disposition === "control-pending")
          this.#store.abandon(
            record.occurrenceKey,
            "control-pending",
            "abandoned-before-send",
          );
        else this.#store.quarantineUnknown(record.occurrenceKey);
        continue;
      }
      if (
        record.disposition === "control-pending" ||
        record.disposition === "delivery-pending"
      )
        await this.#process(record, claims);
      // unknown states intentionally stay parked until expiry/rotation.
    }
  }

  async #process(
    record: TelegramTransportRecord,
    claims: ReturnType<typeof decodeUpdateInteractionClaims>,
  ): Promise<void> {
    if (record.disposition === "control-pending") {
      let mapped: MappedControlRequest;
      try {
        mapped = await this.#mapper.map({
          claims,
          rawUpdate: record.rawUpdate,
        });
      } catch {
        this.#store.abandon(
          record.occurrenceKey,
          "control-pending",
          "abandoned-before-send",
        );
        return;
      }
      const rawPrecondition = (mapped as { readonly ifMatch?: unknown })
        .ifMatch;
      if (
        mapped.kind !== "run" &&
        (typeof rawPrecondition !== "string" || rawPrecondition.length === 0)
      ) {
        this.#store.abandon(
          record.occurrenceKey,
          "control-pending",
          "abandoned-before-send",
        );
        return;
      }
      if (!this.#store.claim(record.occurrenceKey, "control-pending")) return;
      try {
        const response = await this.#control(mapped, record.updateRef, claims);
        if (!response.interactionRef) return; // remains control-unknown
        const responseKind = RESPONSE_KIND[mapped.kind];
        const deliveryOperation = DELIVERY_OPERATION[mapped.kind];
        const interactionDigest = hash(response.interactionRef);
        const deliveryKey = deriveDeliveryKey(
          interactionDigest,
          deliveryOperation,
          responseKind,
        );
        const payloadBytes = new TextEncoder().encode(
          JSON.stringify(response.data),
        );
        if (payloadBytes.byteLength > 16_384) {
          this.#store.quarantineUnknown(record.occurrenceKey);
          return;
        }
        this.#store.recordControlTuple(record.occurrenceKey, {
          controlTuple: {
            mapped,
            idempotencyKey: deriveTelegramIdempotencyKey(
              claims.updateOccurrenceKey,
            ),
            status: response.status,
            etag: response.etag,
          },
          interactionRef: response.interactionRef,
          responseKind,
          deliveryKey,
          deliveryOperation,
          payloadBytes,
          payloadDigest: hash(payloadBytes),
        });
      } catch {
        return; // control-unknown: never auto-resubmit
      }
      record = this.#store.get(record.occurrenceKey)!;
    }

    if (record.disposition === "delivery-pending") {
      if (!this.#store.claim(record.occurrenceKey, "delivery-pending")) return;
      try {
        const result = await this.#port.requestDelivery({
          serviceAuthorityRef: this.#options.serviceAuthorityRef,
          updateInteractionRef: record.updateRef,
          controlInteractionRef: record.interactionRef!,
          responseKind: record.responseKind!,
          deliveryKey: record.deliveryKey!,
          deliveryOperation: record.deliveryOperation!,
          payloadBytes: record.payloadBytes!,
          payloadDigest: record.payloadDigest!,
        });
        this.#store.recordDelivery(
          record.occurrenceKey,
          result.status === "effect"
            ? { status: "effect", effectId: result.effectId }
            : { status: "denied" },
        );
      } catch {
        // delivery-unknown; no repeat even when Effect may already exist.
      }
    }
  }

  async #control(
    mapped: MappedControlRequest,
    channelContext: string,
    claims: ReturnType<typeof decodeUpdateInteractionClaims>,
  ) {
    const idempotencyKey = deriveTelegramIdempotencyKey(
      claims.updateOccurrenceKey,
    );
    if (mapped.kind === "run")
      return this.#sdk.getRun(mapped.runId, { channelContext });
    if (mapped.kind === "intent")
      return this.#sdk.submitIntent(
        mapped.agentId,
        mapped.intentId,
        {
          descriptorVersion: mapped.descriptorVersion,
          executionMode: mapped.executionMode,
          input: mapped.input,
        },
        { idempotencyKey, ifMatch: mapped.ifMatch, channelContext },
      );
    if (mapped.kind === "cancel")
      return this.#sdk.cancelRun(mapped.runId, {
        idempotencyKey,
        ifMatch: mapped.ifMatch,
        channelContext,
      });
    return this.#sdk.decideApproval(mapped.approvalId, mapped.decision, {
      idempotencyKey,
      ifMatch: mapped.ifMatch,
      channelContext,
    });
  }
}
