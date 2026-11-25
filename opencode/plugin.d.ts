export declare const PromptManagerPlugin: (ctx: unknown) => Promise<{
  config: (config: Record<string, any>) => Promise<void>;
  "command.execute.before": (
    input: { sessionID?: string; command: string; arguments?: string },
    output: { parts?: Array<{ type: string; text?: string; [key: string]: unknown }> },
  ) => Promise<void>;
  "chat.message": (
    input: { sessionID?: string; messageID?: string; [key: string]: unknown },
    output: { message?: unknown; parts: Array<{ type: string; text?: string; [key: string]: unknown }> },
  ) => Promise<void>;
}>;

export default PromptManagerPlugin;
