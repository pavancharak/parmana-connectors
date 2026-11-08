import type { ConditionEvaluator } from "./condition-evaluator.js";
import { createRazorpayRefundableEvaluator } from "./evaluators/razorpay-refundable-evaluator.js";
import type { ConnectorName } from "./registry.js";

/**
 * The condition evaluators a connector service runs. Each connector names its own. A connector with no
 * entry here runs with none, so a release carrying conditions for it is refused, as before.
 *
 * The credential is the one the connector uses. It is validated when the configuration loads, and the
 * evaluator reads the payment with it. It is never logged.
 */
export function conditionEvaluatorsFor(
  connector: ConnectorName,
  options: { readonly credential: string; readonly allowLiveKeys: boolean },
): ConditionEvaluator[] {
  switch (connector) {
    case "razorpay":
      return [createRazorpayRefundableEvaluator({ credential: options.credential, allowLiveKeys: options.allowLiveKeys })];
    default:
      return [];
  }
}
