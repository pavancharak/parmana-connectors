import type { ExternalRelease } from "./release.js";

/**
 * A business condition parmana-core signs into an external release. It states a fact the
 * action rests on, and the time until which that fact was observed. Core's field names.
 */
export interface ReleaseCondition {
  readonly signalKey: string;
  readonly source: string;
  readonly claim: string;
  readonly subject: string;
  readonly value: unknown;
  readonly validUntil: string;
  readonly signalId?: string;
}

/**
 * Checks one kind of condition against the system that owns the fact, not against the release.
 * An evaluator for a signal key is the only way this service acts on that condition.
 *
 * `atomicity` says how the check relates to the vendor action, and it is recorded in the answer:
 * - "atomic": the vendor enforces the condition in the same call that acts.
 * - "check-then-act": the condition is checked just before the call. A change between the two
 *   is not caught, so the window is stated, not hidden.
 */
export interface ConditionEvaluator {
  readonly signalKey: string;
  readonly atomicity: "atomic" | "check-then-act";
  evaluate(condition: ReleaseCondition, release: ExternalRelease): Promise<ConditionVerdict>;
}

export type ConditionVerdict = { readonly holds: true } | { readonly holds: false; readonly reason: string };

/** The signal keys this service has evaluators for. */
export function coveredSignalKeys(evaluators: readonly ConditionEvaluator[]): string[] {
  return [...new Set(evaluators.map((evaluator) => evaluator.signalKey))];
}

/** The release's conditions this service has no evaluator for. Empty means every condition can be checked. */
export function uncheckedConditions(conditions: readonly unknown[], covered: readonly string[]): string[] {
  const keys: string[] = [];
  for (const condition of conditions) {
    const key = typeof condition === "object" && condition !== null ? (condition as { signalKey?: unknown }).signalKey : undefined;
    if (typeof key !== "string" || !covered.includes(key)) {
      keys.push(typeof key === "string" ? key : "(unnamed)");
    }
  }
  return keys;
}

export type ConditionOutcome =
  | { readonly status: "holds"; readonly checked: readonly { signalKey: string; atomicity: string }[] }
  | { readonly status: "not-holding"; readonly signalKey: string; readonly reason: string }
  | { readonly status: "unverifiable"; readonly signalKey: string };

/**
 * Checks every condition in order. The first one that does not hold stops the check. An evaluator
 * that throws means the condition could not be verified, which is not the same as a condition that
 * does not hold, so the two are reported differently.
 */
export async function evaluateConditions(
  release: ExternalRelease,
  evaluators: readonly ConditionEvaluator[],
): Promise<ConditionOutcome> {
  const conditions = (release.conditions ?? []) as readonly ReleaseCondition[];
  const checked: { signalKey: string; atomicity: string }[] = [];
  for (const condition of conditions) {
    const evaluator = evaluators.find((candidate) => candidate.signalKey === condition.signalKey);
    if (evaluator === undefined) {
      return { status: "unverifiable", signalKey: condition.signalKey };
    }
    let verdict: ConditionVerdict;
    try {
      verdict = await evaluator.evaluate(condition, release);
    } catch {
      return { status: "unverifiable", signalKey: condition.signalKey };
    }
    if (!verdict.holds) {
      return { status: "not-holding", signalKey: condition.signalKey, reason: verdict.reason.slice(0, 200) };
    }
    checked.push({ signalKey: condition.signalKey, atomicity: evaluator.atomicity });
  }
  return { status: "holds", checked };
}
