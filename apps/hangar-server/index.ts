import { resolve } from "node:path";

import {
  Authenticator,
  type AuthStoreOptions,
} from "../../packages/auth-store-sqlite/index.ts";
import {
  createEffectGateway,
  type ControlOptions,
} from "../../packages/control-core/index.ts";
import {
  openSqliteControl,
  type StoreOptions,
} from "../../packages/control-store-sqlite/index.ts";

export interface HangarServerConfig {
  readonly host?: string;
  readonly tls: boolean;
  readonly secureCookies: boolean;
  readonly controlPath: string;
  readonly controlStore: StoreOptions;
  readonly controlOptions?: ControlOptions;
  readonly authPath: string;
  readonly authOptions: Omit<AuthStoreOptions, "secureCookies">;
  readonly telegramChannel?: {
    readonly updateRefSecret: string;
    readonly controlRefSecret: string;
    readonly serviceAuthorityId: string;
    readonly macKeyGeneration: number;
    readonly nowUnixMs: () => number;
  };
}

const loopback = (host: string): boolean =>
  host === "127.0.0.1" || host === "::1" || host === "localhost";

/** Composition only: wire handlers land in tasks 4.2/4.3. */
export function createHangarServerComposition(config: HangarServerConfig) {
  const host = config.host ?? "127.0.0.1";
  if (!loopback(host) && (!config.tls || !config.secureCookies))
    throw new Error("non_loopback_requires_tls_and_secure_cookies");
  if (resolve(config.controlPath) === resolve(config.authPath))
    throw new Error("auth_store_must_be_physically_separate");
  const control = openSqliteControl(
    config.controlPath,
    config.controlStore,
    config.controlOptions,
  );
  let auth: Authenticator;
  try {
    auth = new Authenticator(config.authPath, {
      ...config.authOptions,
      secureCookies: config.secureCookies,
    });
  } catch (error) {
    control.close();
    throw error;
  }
  const gateway = createEffectGateway(control.control);
  return {
    host,
    control,
    auth,
    gateway,
    telegramChannel: config.telegramChannel,
    close: () => {
      auth.close();
      control.close();
    },
  };
}

export type HangarServerComposition = ReturnType<
  typeof createHangarServerComposition
>;

export {
  createHangarReadServer,
  loadBundledHangarViewAssets,
} from "./http.ts";
export type { HangarHttpComposition, HangarViewAssets } from "./http.ts";
