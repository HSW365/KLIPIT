import crypto from "node:crypto";

// Signed device tokens. No third-party auth service: HMAC over {email, exp}.
const SECRET = () =>
  process.env.SESSION_SECRET ||
  crypto.createHash("sha256").update("klipit:" + (process.env.SUPABASE_SERVICE_ROLE_KEY || "dev")).digest("hex");

const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (body) => crypto.createHmac("sha256", SECRET()).update(body).digest("base64url");

export function issueToken(email, days = 60) {
  const body = b64(JSON.stringify({ e: email.toLowerCase(), x: Date.now() + days * 864e5 }));
  return `${body}.${sign(body)}`;
}

export function readToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const want = sign(body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(body, "base64url").toString());
    return x > Date.now() ? e : null;
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const email = readToken(h.startsWith("Bearer ") ? h.slice(7) : "");
  if (!email) return res.status(401).json({ error: "Sign in to continue." });
  req.email = email;
  next();
}

// Simple in-memory limiter for sign-in attempts.
const hits = new Map();
export function limited(key, max = 6, windowMs = 15 * 60e3) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
