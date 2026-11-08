import { RAZORPAY_REFUND_CAPABILITY } from "../connectors/razorpay/razorpay-connector.js";
import { RAZORPAY_REFUNDABLE_SIGNAL_KEY } from "./evaluators/razorpay-refundable-evaluator.js";

/**
 * The business conditions a capability must carry. A refund that moves money is refused unless the
 * release names the check that must hold before it, so a release cannot skip the check by omitting it.
 * This does not depend on who issued the authorization: the endpoint enforces it itself.
 */
const REQUIRED_CONDITIONS: Readonly<Record<string, readonly string[]>> = {
  [RAZORPAY_REFUND_CAPABILITY]: [RAZORPAY_REFUNDABLE_SIGNAL_KEY],
};

/** The required signal keys for `capability` that `conditions` does not carry. */
export function missingRequiredConditions(capability: string, conditions: readonly unknown[] | undefined): string[] {
  const required = REQUIRED_CONDITIONS[capability] ?? [];
  const present = new Set(
    (conditions ?? []).map((condition) =>
      typeof condition === "object" && condition !== null ? (condition as { signalKey?: unknown }).signalKey : undefined,
    ),
  );
  return required.filter((key) => !present.has(key));
}
