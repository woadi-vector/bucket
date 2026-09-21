import type { TokenUsage } from "./types";

/**
 * The transport seam.
 *
 * An adapter knows how to reach a provider and how to authenticate. It does NOT choose
 * which model to ask or what to ask it — the engine owns model selection, prompting,
 * tiering and parsing. Swapping Token Factory for another provider should mean writing one
 * adapter and touching nothing else.
 */

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CompletionRequest = {
  /** Chosen by the engine, not the caller. */
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider to constrain output to JSON where it supports it. */
  responseFormat?: "json_object" | "text";
  signal?: AbortSignal;
};

export type CompletionResponse = {
  /**
   * The model's answer as text.
   *
   * Adapters must handle a documented Token Factory quirk: the Nemotron models are
   * reasoning models reported to return their output in `reasoning_content` with
   * `content` empty. An adapter that reads only `choices[0].message.content` will hand
   * back an empty string and the engine will see a parse failure rather than the real
   * cause. Merge both fields, and prefer `content` when it is non-empty.
   *
   * This is unverified until the Phase 3 probe script runs against the live API.
   */
  text: string;
  /** Untouched provider payload, kept for logging and for the Phase 3 write-up. */
  raw?: unknown;
  usage?: TokenUsage;
};

export interface ModelAdapter {
  /** Short identifier for telemetry, e.g. "token-factory" or "stub". */
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}
