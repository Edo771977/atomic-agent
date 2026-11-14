import { LOCAL_PROVIDER_KIND, type AtomicAgentConfig } from "../../config/index.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import { routeTurn, type RouteDecision } from "../../llm/router/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";

/**
 * The provider `llm.router` sends this turn to, or undefined to leave
 * the turn as it was (ATO-483). Read once, before the turn starts, from
 * the live config. The caller puts the answer first in the turn's
 * fallback chain (`setTurnPrimary`): every step starts on it, and a
 * failure falls over to the next `llm.fallback` link. See
 * `src/llm/router/README.md`.
 *
 * `needsTools` is true: every agent turn offers tools (even its reply is
 * one), so a rule's `needsTools: false` only matches a caller that hides
 * them all, which none does today.
 */
export function routeTurnProvider(params: {
  config: AtomicAgentConfig;
  userMessage: string;
  workingDir: string;
  pinnedProviderId: string | undefined;
  runMode: Pick<ResolvedRunMode, "stored" | "effective">;
  isRegistered: (providerId: string) => boolean;
  logger: Pick<StructuredLogger, "info">;
  sessionId: string;
  /**
   * True when today's spend ceiling would refuse a paid link now
   * (ATO-649). Such a target is passed over like an unconfigured one: a
   * routed head becomes the turn's primary, so with `onDailyLimit:
   * "stop"` its refusal would end the turn even when the configured
   * primary is free (llama-server, a subscription CLI) and could answer.
   */
  dailyLimitRefuses?: (providerId: string) => boolean;
}): string | undefined {
  const router = params.config.llm?.router;
  if (!router?.enabled) return undefined;
  const resolved = resolveLlmConfig(params.config);
  const decision: RouteDecision = routeTurn({
    router,
    request: {
      message: params.userMessage,
      workingDir: params.workingDir,
      needsTools: true,
    },
    runMode: { stored: params.runMode.stored, effective: params.runMode.effective },
    activeProviderId: resolved.activeTextProvider,
    ...(params.pinnedProviderId !== undefined
      ? { pinnedProviderId: params.pinnedProviderId }
      : {}),
    providers: resolved.providers
      .filter((p) => params.isRegistered(p.id) && params.dailyLimitRefuses?.(p.id) !== true)
      .map((p) => ({
        id: p.id,
        ...(p.supportsTools !== undefined ? { supportsTools: p.supportsTools } : {}),
        ...(p.supportsVision !== undefined ? { supportsVision: p.supportsVision } : {}),
        ...(p.kind === LOCAL_PROVIDER_KIND ? { local: true } : {}),
      })),
  });
  if (!decision.routed) return undefined;
  // The rule's name and the provider only: never the message.
  params.logger.info("model router picked a provider for the turn", {
    sessionId: params.sessionId,
    providerId: decision.providerId,
    rule: decision.rule,
  });
  return decision.providerId;
}
