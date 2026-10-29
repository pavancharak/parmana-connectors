// Runs the Razorpay connector against Razorpay's TEST mode, from your own machine.
// Needs: RAZORPAY_KEY_PAIR="rzp_test_...:<secret>" and RAZORPAY_TEST_PAYMENT_ID="pay_..." (a captured test payment).
// Optional: RAZORPAY_TEST_AMOUNT in paise (default 100). Refunds in test mode move no money.
// The key is read from the environment and never printed.
import { randomUUID } from "node:crypto";

const { createRazorpayConnector } = await import("../dist/connectors/razorpay/razorpay-connector.js");

const key = process.env.RAZORPAY_KEY_PAIR ?? "";
const paymentId = process.env.RAZORPAY_TEST_PAYMENT_ID ?? "";
const amount = Number(process.env.RAZORPAY_TEST_AMOUNT ?? "100");

if (!key.startsWith("rzp_test_")) {
  console.error("Refused: RAZORPAY_KEY_PAIR must be a test key (rzp_test_...). Nothing was called.");
  process.exit(2);
}
if (!/^pay_[A-Za-z0-9]{6,40}$/.test(paymentId)) {
  console.error("Refused: RAZORPAY_TEST_PAYMENT_ID must be a captured test payment id (pay_...). Nothing was called.");
  process.exit(2);
}

const connector = createRazorpayConnector({ allowLiveKeys: false });
const context = { credential: { providerId: "test-run", credentialId: "RAZORPAY_KEY_PAIR", value: key }, timeoutMs: 10_000 };
const transaction = `txn-test-${randomUUID()}`;
const results = [];

function check(name, passed, detail) {
  results.push(passed);
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
}

async function refuse(name, request, code) {
  try {
    await connector.execute(request, context);
    check(name, false, "was accepted but should have been refused");
  } catch (err) {
    check(name, err.code === code, `refused with ${err.code}`);
  }
}

// 1. A refund of the test amount, once.
let first;
try {
  first = await connector.execute(
    { capability: "razorpay:refund", parameters: { amount }, target: paymentId, businessTransactionId: transaction },
    context,
  );
  check("refund is created once", first.success === true && first.metadata.body.alreadyRefunded === false, `refund ${first.metadata.body.refundId}, status ${first.metadata.body.status}`);
} catch (err) {
  check("refund is created once", false, `${err.code}: ${err.message}`);
}

// 2. The same transaction again returns the existing refund, and creates no second one.
if (first) {
  try {
    const again = await connector.execute(
      { capability: "razorpay:refund", parameters: { amount }, target: paymentId, businessTransactionId: transaction },
      context,
    );
    check(
      "repeat returns the existing refund",
      again.metadata.body.alreadyRefunded === true && again.metadata.body.refundId === first.metadata.body.refundId,
      `same refund ${again.metadata.body.refundId}`,
    );
  } catch (err) {
    check("repeat returns the existing refund", false, `${err.code}: ${err.message}`);
  }
}

// 3. Refusals happen before any call to Razorpay.
await refuse("a target that is not a payment id is refused", { capability: "razorpay:refund", parameters: { amount }, target: "order_123", businessTransactionId: randomUUID() }, "invalid_input");
await refuse("a zero amount is refused", { capability: "razorpay:refund", parameters: { amount: 0 }, target: paymentId, businessTransactionId: randomUUID() }, "invalid_input");

const passed = results.filter(Boolean).length;
console.log(`\n${passed} of ${results.length} checks passed.`);
process.exit(passed === results.length ? 0 : 1);
