import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";

const PLUGIN_ID = "gnani";
const PROVIDER_ID = PLUGIN_ID;
const DEFAULT_MODEL_ID = "example-chat";
const DEFAULT_MODEL_REF = "gnani/example-chat";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Gnani AI Speech",
  description: "Add Gnani AI Speech models to OpenClaw.",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Gnani AI Speech",
      docsPath: "/providers/gnani",
      envVars: ["GNANI_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Gnani AI Speech API key",
          hint: "OpenAI-compatible API endpoint",
          optionKey: "gnaniApiKey",
          flagName: "--gnani-api-key",
          envVar: "GNANI_API_KEY",
          promptMessage: "Enter Gnani AI Speech API key",
          defaultModel: DEFAULT_MODEL_REF,
          expectedProviders: [PROVIDER_ID],
          noteTitle: "Gnani AI Speech",
          noteMessage: "Replace https://api.example.com/v1 with your Gnani AI Speech API base URL.",
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          const configuredProvider = Object.entries(ctx.config.models?.providers ?? {}).find(
            ([providerId]) => providerId.trim().toLowerCase() === PROVIDER_ID.toLowerCase(),
          )?.[1];
          return {
            provider: {
              api: "openai-completions",
              models: [
                {
                  id: DEFAULT_MODEL_ID,
                  name: "Example Chat",
                  reasoning: false,
                  input: ["text"],
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  contextWindow: 128000,
                  maxTokens: 8192,
                },
              ],
              apiKey,
              baseUrl: configuredProvider?.baseUrl?.trim() || "https://api.example.com/v1",
            },
          };
        },
      },
    });
  },
});
