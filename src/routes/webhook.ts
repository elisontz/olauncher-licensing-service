import { Env, PlanCode } from "../types";
import { readString, readNestedString, parseJson, generateLicenseKey, nowIso, json } from "../utils";
import { resolveWebhookCustomerEmail, classifyPaddleWebhookEvent, verifyPaddleSignature } from "../services/paddle";
import { maybeSendLicensePurchaseEmail } from "../services/email";

export async function handlePaddleWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  if (!rawBody) {
    return json({ status: "invalid", message: "Invalid JSON payload." }, 400);
  }

  if (!env.PADDLE_WEBHOOK_SECRET?.trim()) {
    return json({ status: "invalid", message: "Webhook secret is not configured." }, 500);
  }

  const signatureHeader = request.headers.get("Paddle-Signature");
  const signatureValid = await verifyPaddleSignature({
    rawBody,
    signatureHeader,
    secret: env.PADDLE_WEBHOOK_SECRET
  });
  if (!signatureValid.valid) {
    console.warn("paddle webhook rejected", JSON.stringify({
      reason: signatureValid.message
    }));
    return json({ status: "invalid", message: signatureValid.message }, 401);
  }

  const payload = parseJson<Record<string, unknown>>(rawBody);
  if (!payload) {
    return json({ status: "invalid", message: "Invalid JSON payload." }, 400);
  }

  const eventId = readString(payload, ["event_id", "eventId", "id"]) ?? crypto.randomUUID();
  const eventType = readString(payload, ["event_type", "eventType", "type"]) ?? "unknown";
  console.log("paddle webhook accepted", JSON.stringify({ eventId, eventType }));

  const alreadyProcessed = await env.DB
    .prepare("SELECT id FROM webhook_events WHERE id = ?")
    .bind(eventId)
    .first<{ id: string }>();
  if (alreadyProcessed) {
    return json({ status: "active", message: "Event already processed." });
  }

  const action = classifyPaddleWebhookEvent(eventType);
  if (action === "create") {
    // If createLicenseFromWebhook throws an error, the webhook fails and Paddle retries.
    await createLicenseFromWebhook(env, payload);
  } else if (action === "revoke") {
    await revokeLicenseFromWebhook(env, payload);
  }

  await env.DB
    .prepare("INSERT INTO webhook_events (id, event_type, processed_at) VALUES (?, ?, ?)")
    .bind(eventId, eventType, nowIso())
    .run();

  return json({ status: "active", message: "Webhook processed." });
}

async function createLicenseFromWebhook(env: Env, payload: Record<string, unknown>): Promise<void> {
  const email = await resolveWebhookCustomerEmail(env, payload);
  const transactionID = readNestedString(payload, [
    ["data", "id"],
    ["data", "transaction_id"],
    ["transaction_id"]
  ]);
  const priceID = readNestedString(payload, [
    ["data", "items", "0", "price", "id"],
    ["data", "price_id"],
    ["price_id"]
  ]);

  if (!email || !transactionID || !priceID) {
    console.warn("license creation skipped", JSON.stringify({
      reason: "missing webhook purchase fields",
      emailPresent: Boolean(email),
      transactionIDPresent: Boolean(transactionID),
      priceIDPresent: Boolean(priceID)
    }));
    return;
  }

  const existing = await env.DB
    .prepare("SELECT id, license_key, plan_code, email_sent_at FROM licenses WHERE paddle_transaction_id = ?")
    .bind(transactionID)
    .first<{ id: string; license_key: string; plan_code: string; email_sent_at: string | null }>();

  let licenseKey = "";
  let planCode: PlanCode = "single";

  if (existing) {
    if (existing.email_sent_at) {
      console.log("license creation skipped", JSON.stringify({
        reason: "transaction already processed and email sent",
        transactionID
      }));
      return;
    } else {
      // License exists but email wasn't successfully sent. Retry sending.
      console.log("license exists but email not sent, retrying email delivery", JSON.stringify({
        transactionID
      }));
      licenseKey = existing.license_key;
      planCode = existing.plan_code as PlanCode;
    }
  } else {
    // Determine plan
    const plan = resolvePlan(env, priceID);
    if (!plan) {
      console.warn("license creation skipped", JSON.stringify({
        reason: "unmapped price id",
        priceID
      }));
      return;
    }
    
    planCode = plan.planCode;
    licenseKey = generateLicenseKey(env.LICENSE_KEY_PREFIX);

    // Insert license
    await env.DB
      .prepare(`
        INSERT INTO licenses (id, email, license_key, plan_code, max_seats, status, source, paddle_transaction_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', 'paddle', ?, ?, ?)
      `)
      .bind(
        crypto.randomUUID(),
        email,
        licenseKey,
        plan.planCode,
        plan.maxSeats,
        transactionID,
        nowIso(),
        nowIso()
      )
      .run();
  }

  // Attempt to send email
  const emailResult = await maybeSendLicensePurchaseEmail(env, {
    email,
    licenseKey,
    planCode,
    transactionID
  });

  if (emailResult.attempted && !emailResult.delivered) {
    console.error("license purchase email failed", JSON.stringify({
      transactionID,
      email,
      licenseKey,
      error: emailResult.error ?? "Unknown email delivery error."
    }));
    // Throw error so Paddle retries
    throw new Error("Email delivery failed, throwing to retry webhook later.");
  }

  if (emailResult.delivered) {
    // Email sent successfully, update tracking field
    await env.DB
      .prepare("UPDATE licenses SET email_sent_at = ? WHERE paddle_transaction_id = ?")
      .bind(nowIso(), transactionID)
      .run();
  }

  if (!emailResult.attempted) {
    console.warn("license purchase email skipped", JSON.stringify({
      transactionID,
      email,
      licenseKey,
      reason: emailResult.error ?? "Missing email delivery configuration."
    }));
    // If not attempted because of missing config, we might still want to mark it or just leave it
    // For now, if config is missing, we don't throw an error, so the webhook succeeds.
  }
}

async function revokeLicenseFromWebhook(env: Env, payload: Record<string, unknown>): Promise<void> {
  const transactionID = readNestedString(payload, [
    ["data", "transaction_id"],
    ["data", "id"],
    ["transaction_id"]
  ]);
  if (!transactionID) {
    return;
  }

  await env.DB
    .prepare("UPDATE licenses SET status = 'revoked', updated_at = ? WHERE paddle_transaction_id = ?")
    .bind(nowIso(), transactionID)
    .run();
}

function resolvePlan(env: Env, priceID: string): { planCode: PlanCode; maxSeats: number } | null {
  if (priceID === env.PADDLE_SINGLE_PRICE_ID) {
    return { planCode: "single", maxSeats: 1 };
  }
  if (env.PADDLE_SINGLE_TEST_PRICE_ID && priceID === env.PADDLE_SINGLE_TEST_PRICE_ID) {
    return { planCode: "single", maxSeats: 1 };
  }
  if (priceID === env.PADDLE_DOUBLE_PRICE_ID) {
    return { planCode: "double", maxSeats: 2 };
  }
  return null;
}
