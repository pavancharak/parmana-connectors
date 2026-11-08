import { describe, expect, it } from "vitest";

import { conditionEvaluatorsFor } from "../../src/service/condition-evaluator-registry.js";

const OPTIONS = { credential: "rzp_test_abc123:secretvalue", allowLiveKeys: false };

describe("conditionEvaluatorsFor", () => {
  it("gives the Razorpay service its payment.refundable evaluator", () => {
    const evaluators = conditionEvaluatorsFor("razorpay", OPTIONS);
    expect(evaluators.map((evaluator) => evaluator.signalKey)).toEqual(["payment.refundable"]);
    expect(evaluators[0]?.atomicity).toBe("check-then-act");
  });

  it("gives other connectors no evaluators, so their releases with conditions are refused", () => {
    for (const connector of ["github", "hubspot", "paytm", "slack", "zoho"] as const) {
      expect(conditionEvaluatorsFor(connector, OPTIONS)).toEqual([]);
    }
  });

  it("refuses a live Razorpay key when live keys are not allowed", () => {
    expect(() => conditionEvaluatorsFor("razorpay", { credential: "rzp_live_abc123:secretvalue", allowLiveKeys: false })).toThrow();
  });
});
