import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLicensePurchaseEmail,
  classifyPaddleWebhookEvent,
  maybeSendLicensePurchaseEmail,
  resolveWebhookCustomerEmail
} from "../src/index.ts";

test("treats successful transaction events as create-license triggers", () => {
  assert.equal(classifyPaddleWebhookEvent("transaction.paid"), "create");
  assert.equal(classifyPaddleWebhookEvent("transaction.completed"), "create");
});

test("treats adjustment events as revoke-license triggers", () => {
  assert.equal(classifyPaddleWebhookEvent("adjustment.created"), "revoke");
  assert.equal(classifyPaddleWebhookEvent("adjustment.updated"), "revoke");
});

test("ignores unrelated webhook events", () => {
  assert.equal(classifyPaddleWebhookEvent("subscription.created"), "ignore");
  assert.equal(classifyPaddleWebhookEvent("unknown"), "ignore");
});

test("uses the email already embedded in a webhook payload when present", async () => {
  const email = await resolveWebhookCustomerEmail(
    { PADDLE_API_KEY: "" } as never,
    {
      data: {
        customer: {
          email: "Buyer@Example.com"
        }
      }
    }
  );

  assert.equal(email, "buyer@example.com");
});

test("fetches customer email from Paddle when the webhook only includes customer_id", async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://sandbox-api.paddle.com/customers/ctm_123");
    assert.equal(init?.headers instanceof Headers, true);
    assert.equal((init?.headers as Headers).get("Authorization"), "Bearer pdl_sdbx_apikey_test");

    return new Response(JSON.stringify({
      data: {
        email: "buyer@example.com"
      }
    }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const email = await resolveWebhookCustomerEmail(
    { PADDLE_API_KEY: "pdl_sdbx_apikey_test" } as never,
    {
      data: {
        customer_id: "ctm_123"
      }
    }
  );

  assert.equal(email, "buyer@example.com");
});

test("uses the live Paddle API host for live API keys", async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.paddle.com/customers/ctm_live");
    assert.equal(init?.headers instanceof Headers, true);
    assert.equal((init?.headers as Headers).get("Authorization"), "Bearer pdl_live_apikey_test");

    return new Response(JSON.stringify({
      data: {
        email: "live@example.com"
      }
    }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const email = await resolveWebhookCustomerEmail(
    { PADDLE_API_KEY: "pdl_live_apikey_test" } as never,
    {
      data: {
        customer_id: "ctm_live"
      }
    }
  );

  assert.equal(email, "live@example.com");
});

test("builds an English-first purchase email with a Chinese supplementary section", () => {
  const email = buildLicensePurchaseEmail({
    to: "buyer@example.com",
    licenseKey: "OL-1234-5678-ABCD",
    planCode: "double",
    supportEmail: "support@example.com"
  });

  assert.equal(email.subject, "Your Liqunch Pro License Key / Liqunch Pro 激活码");
  assert.match(email.text, /^Hi, thank you for purchasing Liqunch Pro\./);
  assert.match(email.text, /buyer@example\.com/);
  assert.match(email.text, /OL-1234-5678-ABCD/);
  assert.match(email.text, /Double-device/);
  assert.match(email.text, /Open the Liqunch app/);
  assert.match(email.text, /\n中文补充\n/);
  assert.match(email.text, /双设备终身版/);
  assert.match(email.text, /打开 Liqunch App/);
  assert.match(email.html, /OL-1234-5678-ABCD/);
  assert.match(email.html, /<h2[^>]*>Your Liqunch Pro License Key<\/h2>/);
  assert.match(email.html, /<h3[^>]*>Chinese Summary<\/h3>/);
  assert.match(email.html, /support@example\.com/);
});

test("sends purchase email with SMTP2GO after license creation details are available", async (t) => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;

  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.smtp2go.com/v3/email/send");
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers instanceof Headers, true);
    assert.equal((init?.headers as Headers).get("content-type"), "application/json");
    assert.equal((init?.headers as Headers).get("X-Smtp2go-Api-Key"), "smtp2go_test_key");

    requestBody = JSON.parse(String(init?.body));

    return new Response(JSON.stringify({ data: { succeeded: 1, failed: 0 } }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await maybeSendLicensePurchaseEmail(
    {
      SMTP2GO_API_KEY: "smtp2go_test_key",
      EMAIL_FROM_ADDRESS: "licenses@example.com",
      EMAIL_FROM_NAME: "Liqunch",
      EMAIL_REPLY_TO: "help@example.com",
      SUPPORT_EMAIL: "support@example.com"
    } as never,
    {
      email: "buyer@example.com",
      licenseKey: "OL-1234-5678-ABCD",
      planCode: "single",
      transactionID: "txn_123"
    }
  );

  assert.deepEqual(result, { attempted: true, delivered: true });
  assert.equal(requestBody?.sender, "Liqunch <licenses@example.com>");
  assert.deepEqual(requestBody?.to, ["buyer@example.com"]);
  assert.deepEqual(requestBody?.reply_to, ["help@example.com"]);
  assert.equal(requestBody?.subject, "Your Liqunch Pro License Key / Liqunch Pro 激活码");
  assert.match(String(requestBody?.text_body), /OL-1234-5678-ABCD/);
  assert.match(String(requestBody?.text_body), /^Hi, thank you for purchasing Liqunch Pro\./);
  assert.match(String(requestBody?.text_body), /\n中文补充\n/);
  assert.match(String(requestBody?.html_body), /support@example\.com/);
});

test("does not fail the flow when SMTP2GO delivery fails", async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ request_id: "req_123", data: { succeeded: 0, failed: 1 }, error: "boom" }), {
      status: 500,
      headers: {
        "content-type": "application/json"
      }
    });

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await maybeSendLicensePurchaseEmail(
    {
      SMTP2GO_API_KEY: "smtp2go_test_key",
      EMAIL_FROM_ADDRESS: "licenses@example.com",
      EMAIL_FROM_NAME: "Liqunch",
      EMAIL_REPLY_TO: "help@example.com",
      SUPPORT_EMAIL: "support@example.com"
    } as never,
    {
      email: "buyer@example.com",
      licenseKey: "OL-1234-5678-ABCD",
      planCode: "single",
      transactionID: "txn_123"
    }
  );

  assert.deepEqual(result, {
    attempted: true,
    delivered: false,
    error: "SMTP2GO delivery failed with status 500."
  });
});

test("skips email delivery when mailer configuration is incomplete", async () => {
  const result = await maybeSendLicensePurchaseEmail(
    {
      SMTP2GO_API_KEY: "",
      EMAIL_FROM_ADDRESS: "licenses@example.com",
      EMAIL_FROM_NAME: "Liqunch",
      EMAIL_REPLY_TO: "help@example.com",
      SUPPORT_EMAIL: "support@example.com"
    } as never,
    {
      email: "buyer@example.com",
      licenseKey: "OL-1234-5678-ABCD",
      planCode: "single",
      transactionID: "txn_123"
    }
  );

  assert.deepEqual(result, {
    attempted: false,
    delivered: false,
    error: "Missing email delivery configuration."
  });
});
