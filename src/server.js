import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { z } from "zod";

import { env } from "./env.js";
import { migrate, openDb } from "./db.js";
import { seedIfEmpty } from "./seed.js";
import {
  fetchCoinGeckoPrices,
  fetchFrankfurterCurrencies,
  fetchFrankfurterLatest,
  fetchOerCurrencies,
  fetchOerLatest,
  upsertFxRatesFromCoinGecko,
  upsertFxRatesFromFrankfurter,
  upsertFxRatesFromLatest,
} from "./fx.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: (origin, cb) => {
    const allow = env.corsAllowOrigins.trim();
    if (allow === "*") return cb(null, true);
    if (!origin) return cb(null, false);
    const allowed = allow.split(",").map((s) => s.trim()).filter(Boolean);
    cb(null, allowed.includes(origin));
  },
});

await app.register(swagger, {
  openapi: {
    info: {
      title: "Freetime Maker Shop API",
      version: "0.1.0",
    },
  },
});

await app.register(swaggerUi, {
  routePrefix: "/docs",
});

const db = openDb();
migrate(db);
seedIfEmpty(db);

app.get("/health", async () => ({ ok: true, ts: new Date().toISOString() }));

function safeJsonParse(raw, fallback) {
  try {
    if (raw == null || raw === "") return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function toProductOut(p) {
  const images = safeJsonParse(p.image_urls, []);
  const prices = safeJsonParse(p.prices_json, null);
  const normalizedPrices =
    prices && typeof prices === "object" && !Array.isArray(prices) ? prices : { [p.currency]: p.unit_amount };

  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    kind: p.kind,
    purchase_url: p.purchase_url ?? null,
    is_active: Boolean(p.is_active),
    images: Array.isArray(images) ? images : [],
    prices: normalizedPrices,
  };
}

function normalizeProductFromFile(p) {
  const images = Array.isArray(p.images)
    ? p.images.map((u) => String(u).trim()).filter(Boolean)
    : [];

  const prices =
    p.prices && typeof p.prices === "object" && !Array.isArray(p.prices) ? p.prices : null;
  const normalizedPrices = prices
    ? Object.fromEntries(
        Object.entries(prices)
          .map(([k, v]) => [String(k).toUpperCase(), Number(v)])
          .filter(([k, v]) => k && Number.isFinite(v) && v >= 0)
      )
    : null;

  const currency = String(p.currency ?? "USD").toUpperCase();
  const unit_amount = Number(p.unit_amount ?? 0);
  const derivedPrices =
    normalizedPrices && Object.keys(normalizedPrices).length
      ? normalizedPrices
      : { [currency]: Number.isFinite(unit_amount) ? unit_amount : 0 };

  return {
    sku: String(p.sku ?? "").trim(),
    name: String(p.name ?? "").trim(),
    description: String(p.description ?? ""),
    kind: String(p.kind ?? "digital"),
    currency,
    unit_amount: Number.isFinite(unit_amount) ? unit_amount : 0,
    purchase_url: p.purchase_url ?? null,
    is_active: p.is_active === false ? 0 : 1,
    image_urls: JSON.stringify(images),
    prices_json: JSON.stringify(derivedPrices),
  };
}

function importProductsFromFile() {
  const filePath = path.resolve(process.cwd(), "data", "products.json");
  if (!fs.existsSync(filePath)) return { ok: false, reason: "missing_file" };

  let json;
  try {
    json = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!Array.isArray(json)) return { ok: false, reason: "not_array" };

  const upsert = db.prepare(`
    INSERT INTO products (sku, name, description, kind, currency, unit_amount, purchase_url, is_active, image_urls, prices_json)
    VALUES (@sku, @name, @description, @kind, @currency, @unit_amount, @purchase_url, @is_active, @image_urls, @prices_json)
    ON CONFLICT(sku) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      kind = excluded.kind,
      currency = excluded.currency,
      unit_amount = excluded.unit_amount,
      purchase_url = excluded.purchase_url,
      is_active = excluded.is_active,
      image_urls = excluded.image_urls,
      prices_json = excluded.prices_json
  `);

  let imported = 0;
  const tx = db.transaction(() => {
    for (const p of json) {
      const n = normalizeProductFromFile(p);
      if (!n.sku || !n.name) continue;
      upsert.run(n);
      imported += 1;
    }
  });
  tx();
  return { ok: true, imported };
}

// Hot-import für data/products.json (ohne Server-Neustart)
try {
  importProductsFromFile();
  const filePath = path.resolve(process.cwd(), "data", "products.json");
  let debounceTimer = null;
  fs.watch(filePath, { persistent: false }, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const res = importProductsFromFile();
      app.log.info({ res }, "Imported products.json");
    }, 150);
  });
} catch {
  // ignore
}

function requireAdmin(req, reply) {
  if (!env.adminToken) {
    return reply
      .code(503)
      .send({ detail: "admin_disabled", hint: "Setze FMS_ADMIN_TOKEN in .env" });
  }
  const token = req.headers["x-admin-token"];
  if (!token || token !== env.adminToken) {
    return reply.code(401).send({ detail: "unauthorized" });
  }
}

function normCcy(ccy) {
  return String(ccy ?? "").trim().toUpperCase();
}

function getFxRate(from, to) {
  const f = normCcy(from);
  const t = normCcy(to);
  if (!f || !t) return null;
  if (f === t) return 1;

  const direct = db
    .prepare("SELECT rate FROM fx_rates WHERE from_currency = ? AND to_currency = ?")
    .get(f, t);
  if (direct?.rate != null) return Number(direct.rate);

  const inv = db
    .prepare("SELECT rate FROM fx_rates WHERE from_currency = ? AND to_currency = ?")
    .get(t, f);
  if (inv?.rate != null && Number(inv.rate) !== 0) return 1 / Number(inv.rate);

  // Fallback: Pivot über USD, wenn vorhanden
  const usd = "USD";
  if (f !== usd && t !== usd) {
    const r1 = getFxRate(f, usd);
    const r2 = getFxRate(usd, t);
    if (r1 != null && r2 != null) return r1 * r2;
  }

  return null;
}

app.get("/products", async (req) => {
  const activeOnly = req.query?.active_only !== "false";
  const stmt = activeOnly
    ? db.prepare("SELECT * FROM products WHERE is_active = 1 ORDER BY id ASC")
    : db.prepare("SELECT * FROM products ORDER BY id ASC");
  const rows = stmt.all();
  return rows.map(toProductOut);
});

app.get("/products/:sku", async (req, reply) => {
  const { sku } = req.params;
  const p = db.prepare("SELECT * FROM products WHERE sku = ?").get(sku);
  if (!p) return reply.code(404).send({ detail: "product_not_found" });
  return toProductOut(p);
});

app.get("/news", async (req) => {
  const limit = Math.max(1, Math.min(Number(req.query?.limit ?? 50), 200));
  const rows = db
    .prepare("SELECT * FROM news ORDER BY created_at DESC LIMIT ?")
    .all(limit);
  return rows;
});

app.get("/fx/rates", async () => {
  const rows = db
    .prepare(
      "SELECT from_currency, to_currency, rate, updated_at FROM fx_rates ORDER BY from_currency ASC, to_currency ASC"
    )
    .all();
  return rows;
});

app.get("/fx/status", async () => {
  const row = db.prepare("SELECT MAX(updated_at) AS updated_at, COUNT(*) AS count FROM fx_rates").get();
  return {
    updated_at: row?.updated_at ?? null,
    count: Number(row?.count ?? 0),
    provider: env.fxProvider,
    include_alternative: Boolean(env.fxIncludeAlternative),
    auto_refresh_seconds: Number(env.fxAutoRefreshSeconds),
    configured:
      env.fxProvider === "openexchangerates" ? Boolean(env.oerAppId) : true,
    crypto_ids: env.cryptoIds.split(",").map((s) => s.trim()).filter(Boolean),
  };
});

app.get("/fx/symbols", async () => {
  if (env.fxProvider === "openexchangerates") {
    const res = await fetchOerCurrencies({ includeAlternative: env.fxIncludeAlternative });
    if (!res.ok) return { ok: false, error: res.error, status: res.status, body: res.body };
    return { ok: true, symbols: res.data };
  }

  const fiat = await fetchFrankfurterCurrencies();
  if (!fiat.ok) return { ok: false, error: fiat.error, status: fiat.status, body: fiat.body };
  const cryptoIds = env.cryptoIds.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    ok: true,
    fiat: fiat.data,
    crypto_ids: cryptoIds,
    note: "Crypto-Symbole werden aus den konfigurierten CoinGecko IDs abgeleitet.",
  };
});

// --- Admin: Produkte pflegen ---
const ProductUpsertIn = z.object({
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  description: z.string().optional().default(""),
  kind: z.enum(["digital", "donation", "token", "support"]),
  currency: z.string().min(1).max(8).default("USD"), // fallback / default currency
  unit_amount: z.number().int().min(0).default(0), // fallback / default price
  prices: z.record(z.string(), z.number().int().min(0)).optional(), // { "USD": 1000, "EUR": 900 }
  images: z.array(z.string().url()).optional(), // mehrere Bilder
  purchase_url: z.string().url().optional().nullable(),
  is_active: z.boolean().optional().default(true),
});

app.put("/admin/products/:sku", { preHandler: requireAdmin }, async (req, reply) => {
  const parsed = ProductUpsertIn.safeParse({ ...(req.body ?? {}), sku: req.params.sku });
  if (!parsed.success) {
    return reply.code(400).send({ detail: "invalid_payload", issues: parsed.error.issues });
  }
  const p = parsed.data;

  const normalizedPrices =
    p.prices && Object.keys(p.prices).length
      ? Object.fromEntries(Object.entries(p.prices).map(([k, v]) => [String(k).toUpperCase(), v]))
      : { [String(p.currency).toUpperCase()]: p.unit_amount };

  const imageUrls = Array.isArray(p.images) ? p.images : [];

  db.prepare(
    `
    INSERT INTO products (sku, name, description, kind, currency, unit_amount, purchase_url, is_active, image_urls, prices_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sku) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      kind = excluded.kind,
      currency = excluded.currency,
      unit_amount = excluded.unit_amount,
      purchase_url = excluded.purchase_url,
      is_active = excluded.is_active,
      image_urls = excluded.image_urls,
      prices_json = excluded.prices_json
  `
  ).run(
    p.sku,
    p.name,
    p.description ?? "",
    p.kind,
    String(p.currency).toUpperCase(),
    p.unit_amount,
    p.purchase_url ?? null,
    p.is_active ? 1 : 0,
    JSON.stringify(imageUrls),
    JSON.stringify(normalizedPrices)
  );

  const out = db.prepare("SELECT * FROM products WHERE sku = ?").get(p.sku);
  return toProductOut(out);
});

app.delete("/admin/products/:sku", { preHandler: requireAdmin }, async (req, reply) => {
  const { sku } = req.params;
  const exists = db.prepare("SELECT id FROM products WHERE sku = ?").get(sku);
  if (!exists) return reply.code(404).send({ detail: "product_not_found" });
  db.prepare("UPDATE products SET is_active = 0 WHERE sku = ?").run(sku);
  return { ok: true };
});

// --- Admin: News pflegen ---
const NewsCreateIn = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
});

app.post("/admin/news", { preHandler: requireAdmin }, async (req, reply) => {
  const parsed = NewsCreateIn.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ detail: "invalid_payload", issues: parsed.error.issues });
  }
  const n = parsed.data;
  const created_at = new Date().toISOString();
  const res = db
    .prepare("INSERT INTO news (title, body, created_at) VALUES (?, ?, ?)")
    .run(n.title, n.body, created_at);
  return reply.code(201).send({ id: Number(res.lastInsertRowid), ...n, created_at });
});

// --- Admin: FX-Kurse pflegen ---
const FxUpsertIn = z.object({
  from_currency: z.string().min(3).max(8),
  to_currency: z.string().min(3).max(8),
  rate: z.number().positive(),
});

app.put("/admin/fx/rates", { preHandler: requireAdmin }, async (req, reply) => {
  const parsed = FxUpsertIn.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ detail: "invalid_payload", issues: parsed.error.issues });
  }
  const r = parsed.data;
  const from = normCcy(r.from_currency);
  const to = normCcy(r.to_currency);
  if (from === to) return reply.code(400).send({ detail: "from_equals_to" });
  const updated_at = new Date().toISOString();

  db.prepare(
    `
      INSERT INTO fx_rates (from_currency, to_currency, rate, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(from_currency, to_currency) DO UPDATE SET
        rate = excluded.rate,
        updated_at = excluded.updated_at
    `
  ).run(from, to, Number(r.rate), updated_at);

  return { from_currency: from, to_currency: to, rate: Number(r.rate), updated_at };
});

app.post("/admin/fx/refresh", { preHandler: requireAdmin }, async (req, reply) => {
  const res = await fxRefreshNow();
  if (!res.ok) return reply.code(502).send(res);
  return res;
});

async function fxRefreshNow() {
  try {
    if (env.fxProvider === "openexchangerates") {
      if (!env.oerAppId) return { ok: false, error: "missing_app_id" };
      const latest = await fetchOerLatest({ includeAlternative: env.fxIncludeAlternative });
      if (!latest.ok) return latest;
      const info = upsertFxRatesFromLatest(db, latest.data);
      return { ok: true, provider: "openexchangerates", ...info };
    }

    // no-key: Frankfurter (fiat) + CoinGecko (crypto)
    const fiatLatest = await fetchFrankfurterLatest({ base: "USD" });
    if (!fiatLatest.ok) return { ok: false, provider: "frankfurter", ...fiatLatest };
    const fiatInfo = upsertFxRatesFromFrankfurter(db, fiatLatest.data);

    const ids = env.cryptoIds.split(",").map((s) => s.trim()).filter(Boolean);
    let cryptoInfo = { base: "USD", updated_at: new Date().toISOString(), count: 0 };
    if (ids.length) {
      const crypto = await fetchCoinGeckoPrices({ ids, vsCurrency: "usd" });
      if (!crypto.ok) return { ok: false, provider: "coingecko", ...crypto };
      cryptoInfo = upsertFxRatesFromCoinGecko(db, crypto.data, { baseFiat: "USD" });
    }

    return {
      ok: true,
      provider: "no-key",
      fiat: { source: "frankfurter", ...fiatInfo },
      crypto: { source: "coingecko", ...cryptoInfo },
    };
  } catch (e) {
    return { ok: false, error: "exception", message: String(e) };
  }
}

// initial + interval
fxRefreshNow().then((res) => app.log.info({ res }, "FX refreshed (startup)"));
const fxIntervalMs = Math.max(60, Number(env.fxAutoRefreshSeconds || 3600)) * 1000;
setInterval(() => {
  fxRefreshNow().then((res) => app.log.info({ res }, "FX refreshed (interval)"));
}, fxIntervalMs).unref();

const CheckoutIn = z.object({
  email: z.string().email(),
  items: z
    .array(
      z.object({
        product_sku: z.string().min(1).max(64),
        quantity: z.number().int().min(1).max(100).default(1),
      })
    )
    .min(1),
  payment_provider: z.string().max(64).optional().nullable(),
  currency: z.string().min(1).max(8).optional(), // gewünschte Zielwährung, z.B. EUR/CHF
});

app.post("/checkout", async (req, reply) => {
  const parsed = CheckoutIn.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ detail: "invalid_payload", issues: parsed.error.issues });
  }
  const payload = parsed.data;

  const skus = [...new Set(payload.items.map((i) => i.product_sku))];
  const placeholders = skus.map(() => "?").join(",");
  const products = db
    .prepare(`SELECT * FROM products WHERE sku IN (${placeholders})`)
    .all(...skus);
  const bySku = new Map(products.map((p) => [p.sku, p]));

  const missing = payload.items.map((i) => i.product_sku).filter((s) => !bySku.has(s));
  if (missing.length) {
    return reply.code(400).send({ detail: { code: "unknown_product_sku", skus: missing } });
  }

  const requestedCurrency = payload.currency ? String(payload.currency).toUpperCase() : null;
  const currency =
    requestedCurrency ??
    String(products[0]?.currency ?? "USD").toUpperCase();

  let total = 0;
  const now = new Date().toISOString();
  const publicId = newPublicId("ord");
  const status = payload.payment_provider ? "pending_payment" : "created";

  const tx = db.transaction(() => {
    const orderRes = db
      .prepare(
        `
        INSERT INTO orders (public_id, email, status, payment_provider, currency, total_amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(publicId, payload.email, status, payload.payment_provider ?? null, currency, 0, now);

    const orderId = orderRes.lastInsertRowid;

    const insertItem = db.prepare(
      `
        INSERT INTO order_items (order_id, product_id, quantity, unit_amount, currency)
        VALUES (?, ?, ?, ?, ?)
      `
    );

    for (const it of payload.items) {
      const p = bySku.get(it.product_sku);
      const prices = safeJsonParse(p.prices_json, null);
      const priceMap =
        prices && typeof prices === "object" && !Array.isArray(prices)
          ? prices
          : { [normCcy(p.currency ?? "USD")]: Number(p.unit_amount ?? 0) };

      let unit;
      if (priceMap[currency] != null) {
        unit = Number(priceMap[currency]);
      } else {
        // Kurswechsel: versuche aus einer vorhandenen Währung umzurechnen
        const entries = Object.entries(priceMap);
        const base = entries.find(([ccy, v]) => normCcy(ccy) && Number.isFinite(Number(v)));
        if (!base) {
          return reply.code(400).send({ detail: { code: "no_base_price", sku: p.sku } });
        }
        const [baseCcy, baseAmount] = base;
        const rate = getFxRate(baseCcy, currency);
        if (rate == null) {
          return reply.code(400).send({
            detail: {
              code: "fx_rate_missing",
              sku: p.sku,
              from_currency: normCcy(baseCcy),
              to_currency: currency,
            },
          });
        }
        unit = Math.round(Number(baseAmount) * Number(rate));
      }

      total += unit * Number(it.quantity);
      insertItem.run(orderId, p.id, Number(it.quantity), unit, currency);
    }

    db.prepare("UPDATE orders SET total_amount = ? WHERE id = ?").run(total, orderId);
  });
  tx();

  return reply.code(201).send({
    order_id: publicId,
    status,
    currency,
    total_amount: total,
    payment_provider: payload.payment_provider ?? null,
  });
});

app.get("/orders/:order_id", async (req, reply) => {
  const { order_id } = req.params;
  const o = db.prepare("SELECT * FROM orders WHERE public_id = ?").get(order_id);
  if (!o) return reply.code(404).send({ detail: "order_not_found" });

  const items = db
    .prepare(
      `
      SELECT oi.quantity, oi.unit_amount, oi.currency, p.sku AS product_sku, p.name AS name
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?
      ORDER BY oi.id ASC
    `
    )
    .all(o.id);

  return {
    order_id: o.public_id,
    email: o.email,
    status: o.status,
    currency: o.currency,
    total_amount: o.total_amount,
    created_at: o.created_at,
    fulfillment_code: o.fulfillment_code ?? null,
    items,
  };
});

const FulfillIn = z.object({ fulfillment_code: z.string().min(1).max(200) });

app.post("/orders/:order_id/fulfill", async (req, reply) => {
  const { order_id } = req.params;
  const parsed = FulfillIn.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ detail: "invalid_payload", issues: parsed.error.issues });
  }
  const o = db.prepare("SELECT * FROM orders WHERE public_id = ?").get(order_id);
  if (!o) return reply.code(404).send({ detail: "order_not_found" });

  db.prepare("UPDATE orders SET status = 'fulfilled', fulfillment_code = ? WHERE id = ?").run(
    parsed.data.fulfillment_code,
    o.id
  );
  return reply.redirect(303, `/orders/${order_id}`);
});

const SupportIn = z.object({
  email: z.string().email(),
  subject: z.string().min(1).max(200),
  message: z.string().min(1).max(10000),
});

app.post("/support/tickets", async (req, reply) => {
  const parsed = SupportIn.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ detail: "invalid_payload", issues: parsed.error.issues });
  }
  const publicId = newPublicId("sup");
  db.prepare(
    `
      INSERT INTO support_tickets (public_id, email, subject, message, created_at)
      VALUES (?, ?, ?, ?, ?)
    `
  ).run(publicId, parsed.data.email, parsed.data.subject, parsed.data.message, new Date().toISOString());

  return reply.code(201).send({ ticket_id: publicId, created_at: new Date().toISOString() });
});

function newPublicId(prefix) {
  // kurz + URL-safe
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}

await app.listen({ host: env.host, port: env.port });

