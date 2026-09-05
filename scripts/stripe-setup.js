import "dotenv/config";
import Stripe from "stripe";
import { TIERS } from "../server/lib/tiers.js";

// Creates one Stripe Product + monthly Price per tier, then prints the env lines to paste.
// Run AFTER you've confirmed the prices in tiers.js:  npm run stripe:setup
// Safe to re-run: it looks up by product name and reuses the product, adding a new price only
// if the amount changed.

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("Set STRIPE_SECRET_KEY in .env first.");
  process.exit(1);
}
const stripe = new Stripe(key, { apiVersion: "2024-06-20" });
const LIVE = key.startsWith("sk_live");

console.log(`\nCreating Klipit plans in Stripe ${LIVE ? "LIVE" : "TEST"} mode…\n`);

const envLines = [];
for (const t of Object.values(TIERS)) {
  const name = `Klipit ${t.name}`;
  // find or create product
  const found = await stripe.products.search({ query: `name:'${name}' AND active:'true'` });
  let product = found.data[0];
  if (!product) {
    product = await stripe.products.create({
      name,
      description: `${t.clipsPerStream} clips/stream · scans ${t.maxMinutes}min · ${t.resolution}p`,
      metadata: { tier: t.key },
    });
    console.log(`created product  ${name}`);
  } else {
    console.log(`reusing product  ${name}`);
  }

  const amount = t.priceUsd * 100;
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  let price = prices.data.find((p) => p.unit_amount === amount && p.recurring?.interval === "month");
  if (!price) {
    price = await stripe.prices.create({
      product: product.id,
      unit_amount: amount,
      currency: "usd",
      recurring: { interval: "month" },
      metadata: { tier: t.key },
    });
    console.log(`created price    $${t.priceUsd}/mo -> ${price.id}`);
  } else {
    console.log(`reusing price    $${t.priceUsd}/mo -> ${price.id}`);
  }
  envLines.push(`${t.priceEnv}=${price.id}`);
}

console.log("\nAdd these to your .env / Render env:\n");
console.log(envLines.join("\n"));
console.log("");
