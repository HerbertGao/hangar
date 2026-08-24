import {
  SessionManager,
  SettingsManager,
  VERSION,
  createAgentSession,
  createExtensionRuntime,
  type AgentSession,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { VirtualCorpus } from "./virtual-corpus.ts";

const extensionRuntime = createExtensionRuntime();

/** Explicit empty resource source: no global/project discovery or commands. */
export const EMPTY_RESOURCE_LOADER: ResourceLoader = {
  getExtensions: () => ({
    extensions: [],
    errors: [],
    runtime: extensionRuntime,
  }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "You are a release-pinned read-only fixture agent.",
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

const pathSchema = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
} as const;
const prefixSchema = {
  type: "object",
  properties: { prefix: { type: "string" } },
  additionalProperties: false,
} as const;
const querySchema = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
  additionalProperties: false,
} as const;

const argument = (params: unknown, field: string): string | undefined =>
  params &&
  typeof params === "object" &&
  !Array.isArray(params) &&
  typeof (params as Record<string, unknown>)[field] === "string"
    ? ((params as Record<string, unknown>)[field] as string)
    : undefined;

/** Tool code delegates only to VirtualCorpus; this module imports no node:fs. */
export function createVirtualCorpusTools(
  corpus: VirtualCorpus,
): readonly ToolDefinition[] {
  const definitions = [
    {
      name: "virtual_read",
      label: "Read virtual file",
      description: "Read one release-pinned virtual regular file.",
      parameters: pathSchema,
      execute: async (_id: string, params: unknown) => {
        const path = argument(params, "path");
        const result = path
          ? corpus.read(path)
          : ({ ok: false, error: "invalid_path" } as const);
        if (!result.ok)
          return {
            content: [{ type: "text" as const, text: `error:${result.error}` }],
            details: {},
          };
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(result.value);
        } catch {
          text = "error:non_utf8_virtual_entry";
        }
        return { content: [{ type: "text" as const, text }], details: {} };
      },
    },
    {
      name: "virtual_list",
      label: "List virtual files",
      description: "List release-pinned virtual paths in canonical order.",
      parameters: prefixSchema,
      execute: async (_id: string, params: unknown) => {
        const prefix = argument(params, "prefix") ?? "";
        const result = corpus.list(prefix);
        return {
          content: [
            {
              type: "text" as const,
              text: result.ok
                ? result.value.join("\n")
                : `error:${result.error}`,
            },
          ],
          details: {},
        };
      },
    },
    {
      name: "virtual_search",
      label: "Search virtual files",
      description: "Search bytes in the release-pinned corpus.",
      parameters: querySchema,
      execute: async (_id: string, params: unknown) => {
        const query = argument(params, "query");
        const result = query
          ? corpus.search(query)
          : ({ ok: false, error: "invalid_query" } as const);
        return {
          content: [
            {
              type: "text" as const,
              text: result.ok
                ? JSON.stringify(result.value)
                : `error:${result.error}`,
            },
          ],
          details: {},
        };
      },
    },
  ];
  // SAFETY: these are standard JSON schemas accepted by Pi's public
  // ToolDefinition boundary; execute treats params as unknown and revalidates.
  return definitions as unknown as readonly ToolDefinition[];
}

export interface PiIsolationQualification {
  readonly qualification: "fixture-readonly-reference";
  readonly sdkVersion: "0.84.2";
  readonly tools: readonly ["virtual_list", "virtual_read", "virtual_search"];
  readonly globalResources: 0;
  readonly projectResources: 0;
  readonly slashCommands: 0;
  readonly persistentSession: false;
  readonly liveWorkspaceEligible: false;
  readonly productionEligible: false;
  readonly mutationCapable: false;
}

export async function createIsolatedPiSession(
  corpus: VirtualCorpus,
): Promise<{ session: AgentSession; qualification: PiIsolationQualification }> {
  if (VERSION !== "0.84.2") throw new Error("pi_sdk_version_mismatch");
  const customTools = createVirtualCorpusTools(corpus);
  const { session } = await createAgentSession({
    cwd: "/hangar/virtual",
    agentDir: "/hangar/empty-agent",
    noTools: "all",
    tools: customTools.map(({ name }) => name),
    customTools: [...customTools],
    resourceLoader: EMPTY_RESOURCE_LOADER,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0 },
    }),
  });
  const tools = session.agent.state.tools.map(({ name }) => name).sort();
  const expected = ["virtual_list", "virtual_read", "virtual_search"] as const;
  if (JSON.stringify(tools) !== JSON.stringify(expected)) {
    session.dispose();
    throw new Error("unexpected_pi_tool_surface");
  }
  if (
    EMPTY_RESOURCE_LOADER.getExtensions().extensions.length !== 0 ||
    EMPTY_RESOURCE_LOADER.getSkills().skills.length !== 0 ||
    EMPTY_RESOURCE_LOADER.getPrompts().prompts.length !== 0 ||
    EMPTY_RESOURCE_LOADER.getThemes().themes.length !== 0 ||
    EMPTY_RESOURCE_LOADER.getAgentsFiles().agentsFiles.length !== 0 ||
    session.sessionFile !== undefined
  ) {
    session.dispose();
    throw new Error("unexpected_pi_resource_surface");
  }
  return {
    session,
    qualification: {
      qualification: "fixture-readonly-reference",
      sdkVersion: "0.84.2",
      tools: expected,
      globalResources: 0,
      projectResources: 0,
      slashCommands: 0,
      persistentSession: false,
      liveWorkspaceEligible: false,
      productionEligible: false,
      mutationCapable: false,
    },
  };
}
