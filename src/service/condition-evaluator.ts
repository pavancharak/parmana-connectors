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

/** Facts the evaluator observed, recorded with the answer. Plain values only; never a credential. */
export type ConditionEvidence = Readonly<Record<string, string | number | boolean | null>>;

export type ConditionVerdict =
  | { readonly holds: true; readonly evidence?: ConditionEvidence }
  | { readonly holds: false; readonly reason: string; readonly evidence?: ConditionEvidence };

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

/** One condition's record in an answer: whether it held, what was observed, and how its check relates to the action. */
export interface CheckedCondition {
  readonly signalKey: string;
  readonly atomicity: string;
  /** "holds", "not-holding" (checked and false) or "unverified" (could not be checked). */
  readonly outcome: "holds" | "not-holding" | "unverified";
  readonly evidence?: ConditionEvidence;
}

export type ConditionOutcome =
  | { readonly status: "holds"; readonly checked: readonly CheckedCondition[] }
  | {
      readonly status: "not-holding";
      readonly reason: string;
      /** The conditions that held before this one. */
      readonly checked: readonly CheckedCondition[];
      /** The condition that does not hold, with the evidence the evaluator observed. */
      readonly failed: CheckedCondition;
    }
  | {
      readonly status: "unverifiable";
      readonly checked: readonly CheckedCondition[];
      /** The condition that could not be checked. */
      readonly failed: CheckedCondition;
    };

/** The signal key of the first condition, for logs and messages. */
export function signalKeyOf(outcome: Exclude<ConditionOutcome, { status: "holds" }>): string {
  return outcome.failed.signalKey;
}

/**
 * Checks every condition in order. The first one that does not hold stops the check. An evaluator
 * that throws means the condition could not be verified, which is not the same as a condition that
 * does not hold, so the two are reported differently. Evidence is kept on every outcome.
 */
export async function evaluateConditions(
  release: ExternalRelease,
  evaluators: readonly ConditionEvaluator[],
): Promise<ConditionOutcome> {
  const conditions = (release.conditions ?? []) as readonly ReleaseCondition[];
  const checked: CheckedCondition[] = [];
  for (const condition of conditions) {
    const evaluator = evaluators.find((candidate) => candidate.signalKey === condition.signalKey);
    if (evaluator === undefined) {
      return {
        status: "unverifiable",
        checked,
        failed: { signalKey: condition.signalKey, atomicity: "not-evaluated", outcome: "unverified" },
      };
    }
    let verdict: ConditionVerdict;
    try {
      verdict = await evaluator.evaluate(condition, release);
    } catch {
      return {
        status: "unverifiable",
        checked,
        failed: { signalKey: condition.signalKey, atomicity: evaluator.atomicity, outcome: "unverified" },
      };
    }
    if (!verdict.holds) {
      const failed: CheckedCondition = {
        signalKey: condition.signalKey,
        atomicity: evaluator.atomicity,
        outcome: "not-holding",
        ...(verdict.evidence !== undefined ? { evidence: verdict.evidence } : {}),
      };
      return { status: "not-holding", reason: verdict.reason.slice(0, 200), checked, failed };
    }
    checked.push({
      signalKey: condition.signalKey,
      atomicity: evaluator.atomicity,
      outcome: "holds",
      ...(verdict.evidence !== undefined ? { evidence: verdict.evidence } : {}),
    });
  }
  return { status: "holds", checked };
}
