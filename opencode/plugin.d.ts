export interface PromptManagerPluginHooks {
  config: (config: Record<string, any>) => Promise<void>;
  "command.execute.before": (
    input: { sessionID?: string; command: string; arguments?: string },
    output: { parts?: Array<{ type: string; text?: string; [key: string]: unknown }> },
  ) => Promise<void>;
  "chat.message": (
    input: { sessionID?: string; messageID?: string; [key: string]: unknown },
    output: { message?: unknown; parts: Array<{ type: string; text?: string; [key: string]: unknown }> },
  ) => Promise<void>;
}

export declare const createPromptManagerHooks: (ctx: unknown) => Promise<PromptManagerPluginHooks>;
export declare const PromptManagerPlugin: (ctx: unknown) => Promise<PromptManagerPluginHooks>;

export interface OpenCodePluginDefinition {
  id: string;
  name?: string;
  description?: string;
  setup: (ctx: unknown) => Promise<PromptManagerPluginHooks>;
}

export declare const plugin: OpenCodePluginDefinition;
export default plugin;
