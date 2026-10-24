import Stripe from "stripe";
import { TIERS, tierFromPriceId } from "./tiers.js";
import { upsertSubscriber } from "./supabase.js";

// Lazy singleton — don't throw at import when STRIPE_SECRET_KEY is unset.
let _stripe = null;
export function stripeClient() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Stripe not configured: set STRIPE_SECRET_KEY");
  _stripe = new Stripe(key, { apiVersion: "2024-06-20" });
  return _stripe;
}

const APP_URL = () => process.env.APP_URL || "http://localhost:3000";

export async function createCheckoutSession(tierKey, email) {
  const tier = TIERS[tierKey];
  if (!tier) throw new Error(`Unknown tier: ${tierKey}`);
  const priceId = process.env[tier.priceEnv];
  if (!priceId) throw new Error(`Missing ${tier.priceEnv} — run npm run stripe:setup first`);

  return stripeClient().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: email || undefined,
    allow_promotion_codes: true,
    success_url: `${APP_URL()}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL()}/?checkout=cancel`,
    metadata: { tier: tierKey },
  });
}

// After checkout: confirm the session is paid and sync the subscriber right away (don't wait on the webhook).
export async function confirmCheckout(sessionId) {
  const stripe = stripeClient();
  const s = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["subscription", "customer"] });
  if (s.status !== "complete" || !s.subscription) throw new Error("Checkout is not complete yet.");
  const sub = s.subscription;
  const email = (s.customer?.email || s.customer_details?.email || s.customer_email || "").toLowerCase();
  const tier = tierFromPriceId(sub.items?.data?.[0]?.price?.id) || s.metadata?.tier || "starter";
  await upsertSubscriber({
    email,
    stripeCustomerId: s.customer?.id || s.customer,
    tier,
    status: ["active", "trialing"].includes(sub.status) ? "active" : sub.status,
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
  });
  return email;
}

// Last 4 digits of the card paying for this customer's subscription (used to verify sign-in on a new device).
export async function cardLast4(customerId) {
  const stripe = stripeClient();
  const out = new Set();
  const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 5, expand: ["data.default_payment_method"] });
  for (const s of subs.data) if (s.default_payment_method?.card?.last4) out.add(s.default_payment_method.card.last4);
  const cust = await stripe.customers.retrieve(customerId, { expand: ["invoice_settings.default_payment_method"] });
  const pm = cust.invoice_settings?.default_payment_method;
  if (pm?.card?.last4) out.add(pm.card.last4);
  if (!out.size) {
    const pms = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 5 });
    pms.data.forEach((p) => out.add(p.card.last4));
  }
  return [...out];
}

// Stripe-hosted billing page: update card, see invoices, cancel.
let _portalConfig = null;
export async function billingPortal(customerId) {
  const stripe = stripeClient();
  if (!_portalConfig) {
    const list = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 });
    _portalConfig = list.data[0]?.id || (await stripe.billingPortal.configurations.create({
      business_profile: { headline: "Klipit by HSW365 Media" },
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        customer_update: { enabled: true, allowed_updates: ["email"] },
        subscription_cancel: { enabled: true, mode: "at_period_end" },
      },
    })).id;
  }
  const s = await stripe.billingPortal.sessions.create({ customer: customerId, configuration: _portalConfig, return_url: `${APP_URL()}/#account` });
  return s.url;
}

// Verify + route Stripe webhook events. Returns a short summary string.
export async function handleWebhook(rawBody, signature) {
  const stripe = stripeClient();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);

  switch (event.type) {
    case "checkout.session.completed":
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const obj = event.data.object;
      const customerId =
        obj.customer || (obj.subscription && (await stripe.subscriptions.retrieve(obj.subscription)).customer);
      const sub =
        event.type === "checkout.session.completed"
          ? await stripe.subscriptions.retrieve(obj.subscription)
          : obj;
      const priceId = sub.items?.data?.[0]?.price?.id;
      const tier = tierFromPriceId(priceId) || sub.metadata?.tier || "starter";
      const customer = await stripe.customers.retrieve(customerId);
      await upsertSubscriber({
        email: customer.email || obj.customer_email,
        stripeCustomerId: customerId,
        tier,
        status: sub.status === "trialing" ? "active" : sub.status,
        currentPeriodEnd: sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null,
      });
      return `synced ${tier} for ${customerId}`;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const customer = await stripe.customers.retrieve(sub.customer);
      await upsertSubscriber({
        email: customer.email,
        stripeCustomerId: sub.customer,
        tier: sub.metadata?.tier || "starter",
        status: "canceled",
        currentPeriodEnd: null,
      });
      return `canceled ${sub.customer}`;
    }
    default:
      return `ignored ${event.type}`;
  }
}
