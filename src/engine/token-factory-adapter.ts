import type { CompletionRequest, CompletionResponse, ModelAdapter } from "./adapter";

export const TOKEN_FACTORY_BASE_URL = "https://api.tokenfactory.nebius.com/v1";

export type TokenFactoryOptions = {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests. Defaults to global fetch — Workers-safe, no Node-only APIs. */
  fetchImpl?: typeof fetch;
  /** Hard ceiling on a single call. */
  timeoutMs?: number;
};

export class TokenFactoryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly finishReason?: string,
  ) {
    super(message);
    this.name = "TokenFactoryError";
  }
}

type ChatCompletionPayload = {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; reasoning_content?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  };
};

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Token Factory transport (OpenAI-compatible).
 *
 * Shaped by the Phase 3 probe rather than by the assumptions we started with — see
 * docs/token-factory-findings.md. Two of those findings are encoded here directly.
 */
export function createTokenFactoryAdapter(options: TokenFactoryOptions): ModelAdapter {
  const {
    apiKey,
    baseUrl = TOKEN_FACTORY_BASE_URL,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  if (!apiKey) throw new TokenFactoryError("Token Factory adapter requires an API key");

  return {
    name: "token-factory",

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), timeoutMs);

      // Honour both the caller's signal and our own timeout.
      const onAbort = () => timeout.abort();
      request.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          signal: timeout.signal,
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            max_tokens: request.maxTokens,
            temperature: request.temperature,
            ...(request.responseFormat === "json_object"
              ? { response_format: { type: "json_object" } }
              : {}),
          }),
        });

        const text = await res.text();
        if (!res.ok) {
          // Never let a key echoed back in an error body reach a log.
          throw new TokenFactoryError(
            `Token Factory returned ${res.status}: ${text.split(apiKey).join("<REDACTED>").slice(0, 500)}`,
            res.status,
          );
        }

        let payload: ChatCompletionPayload;
        try {
          payload = JSON.parse(text) as ChatCompletionPayload;
        } catch {
          throw new TokenFactoryError("Token Factory returned a non-JSON body");
        }

        const choice = payload.choices?.[0];
        const content = choice?.message?.content ?? "";
        const reasoning = choice?.message?.reasoning_content ?? "";

        /**
         * A truncated response comes back as HTTP 200 with an empty `content` string and
         * `finish_reason: "length"`. Measured: max_tokens 256 burned all 256 tokens and
         * returned nothing. Without this branch that surfaces as "the model gave us
         * unparseable output", which sends you debugging the prompt instead of the budget.
         */
        if (!content && choice?.finish_reason === "length") {
          throw new TokenFactoryError(
            "Response truncated before any content was emitted — raise max_tokens",
            res.status,
            choice.finish_reason,
          );
        }

        /**
         * Prefer `content`; fall back to `reasoning_content`.
         *
         * The reported failure mode (answer only in `reasoning_content`) did not reproduce:
         * Nano populates `content` and omits the trace, Ultra populates both. The fallback
         * stays as cheap insurance, since the behaviour differs per model and could change.
         */
        const usage = payload.usage;

        return {
          text: content || reasoning,
          raw: payload,
          usage: usage
            ? {
                promptTokens: usage.prompt_tokens ?? 0,
                completionTokens: usage.completion_tokens ?? 0,
                totalTokens: usage.total_tokens ?? 0,
              }
            : undefined,
        };
      } catch (error) {
        if (error instanceof TokenFactoryError) throw error;
        if (error instanceof Error && error.name === "AbortError") {
          throw new TokenFactoryError(`Token Factory call aborted after ${timeoutMs}ms`);
        }
        throw new TokenFactoryError(
          error instanceof Error ? error.message : "Token Factory call failed",
        );
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
