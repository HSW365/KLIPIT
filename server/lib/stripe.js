import Stripe from "stripe";
import { TIERS, tierFromPriceId } from "./tiers.js";
import { upsertSubscriber } from "./supabase.js";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-06-20",
});

const APP_URL = process.env.APP_URL || "http://localhost:3000";

export async function createCheckoutSession(tierKey, email) {
  const tier = TIERS[tierKey];
  if (!tier) throw new Error(`Unknown tier: ${tierKey}`);
  const priceId = process.env[tier.priceEnv];
  if (!priceId) throw new Error(`Missing ${tier.priceEnv} — run npm run stripe:setup first`);

  return stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: email || undefined,
    allow_promotion_codes: true,
    success_url: `${APP_URL}/?checkout=success&email={CHECKOUT_SESSION_CUSTOMER_EMAIL}`,
    cancel_url: `${APP_URL}/?checkout=cancel`,
    metadata: { tier: tierKey },
  });
}

// Verify + route Stripe webhook events. Returns a short summary string.
export async function handleWebhook(rawBody, signature) {
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
