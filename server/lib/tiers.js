// Klipit subscription tiers — single source of truth.
// Prices here are PLACEHOLDERS. Confirm final numbers, then run `npm run stripe:setup`
// which creates the Stripe products/prices and prints the price IDs to drop into env.

export const TIERS = {
  starter: {
    key: "starter",
    name: "Starter",
    priceUsd: 20,         // monthly, USD — CONFIRMED
    clipsPerStream: 3,    // max clips generated per pasted stream
    maxMinutes: 30,       // max span of source stream scanned for highlights
    resolution: 720,      // vertical output height
    watermark: true,      // Klipit watermark burned in
    captions: false,      // burn-in captions on clips
    priceEnv: "STRIPE_PRICE_STARTER",
  },
  pro: {
    key: "pro",
    name: "Pro",
    priceUsd: 45,
    clipsPerStream: 15,
    maxMinutes: 120,
    resolution: 1080,
    watermark: false,
    captions: true,
    priceEnv: "STRIPE_PRICE_PRO",
  },
  elite: {
    key: "elite",
    name: "Elite",
    priceUsd: 99,
    clipsPerStream: 40,
    maxMinutes: 480,
    resolution: 1080,
    watermark: false,
    captions: true,
    priceEnv: "STRIPE_PRICE_ELITE",
  },
};

export function tierFromPriceId(priceId) {
  for (const t of Object.values(TIERS)) {
    if (process.env[t.priceEnv] && process.env[t.priceEnv] === priceId) return t.key;
  }
  return null;
}

export function getTier(key) {
  return TIERS[key] || null;
}
