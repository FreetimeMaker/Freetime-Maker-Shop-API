import { env } from "./env.js";

const OER_BASE_URL = "https://openexchangerates.org/api";
const FRANKFURTER_BASE_URL = "https://api.frankfurter.app";
const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";

export async function fetchOerLatest({ includeAlternative }) {
  if (!env.oerAppId) {
    return { ok: false, error: "missing_app_id" };
  }

  const url = new URL(`${OER_BASE_URL}/latest.json`);
  url.searchParams.set("app_id", env.oerAppId);
  url.searchParams.set("prettyprint", "0");
  if (includeAlternative) url.searchParams.set("show_alternative", "1");

  const res = await fetch(url.toString(), {
    headers: { "user-agent": "freetime-maker-shop-api/0.1.0" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: "http_error", status: res.status, body: text.slice(0, 300) };
  }
  const json = await res.json();
  return { ok: true, data: json };
}

export async function fetchOerCurrencies({ includeAlternative }) {
  const url = new URL(`${OER_BASE_URL}/currencies.json`);
  url.searchParams.set("prettyprint", "0");
  if (includeAlternative) url.searchParams.set("show_alternative", "1");

  const res = await fetch(url.toString(), {
    headers: { "user-agent": "freetime-maker-shop-api/0.1.0" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: "http_error", status: res.status, body: text.slice(0, 300) };
  }
  const json = await res.json();
  return { ok: true, data: json };
}

export function upsertFxRatesFromLatest(db, latest) {
  const base = String(latest.base ?? "USD").toUpperCase();
  const updatedAt = latest.timestamp
    ? new Date(Number(latest.timestamp) * 1000).toISOString()
    : new Date().toISOString();

  const rates = latest.rates && typeof latest.rates === "object" ? latest.rates : {};

  const upsert = db.prepare(`
    INSERT INTO fx_rates (from_currency, to_currency, rate, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(from_currency, to_currency) DO UPDATE SET
      rate = excluded.rate,
      updated_at = excluded.updated_at
  `);

  let count = 0;
  const tx = db.transaction(() => {
    for (const [to, rateRaw] of Object.entries(rates)) {
      const toCcy = String(to).toUpperCase();
      const rate = Number(rateRaw);
      if (!toCcy || !Number.isFinite(rate) || rate <= 0) continue;
      upsert.run(base, toCcy, rate, updatedAt);
      count += 1;
    }
    // auch base->base speichern
    upsert.run(base, base, 1, updatedAt);
  });
  tx();

  return { base, updated_at: updatedAt, count };
}

export async function fetchFrankfurterLatest({ base }) {
  const from = String(base ?? "USD").toUpperCase();
  const url = new URL(`${FRANKFURTER_BASE_URL}/latest`);
  url.searchParams.set("from", from);

  const res = await fetch(url.toString(), {
    headers: { "user-agent": "freetime-maker-shop-api/0.1.0" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: "http_error", status: res.status, body: text.slice(0, 300) };
  }
  const json = await res.json();
  return { ok: true, data: json };
}

export async function fetchFrankfurterCurrencies() {
  const url = new URL(`${FRANKFURTER_BASE_URL}/currencies`);
  const res = await fetch(url.toString(), {
    headers: { "user-agent": "freetime-maker-shop-api/0.1.0" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: "http_error", status: res.status, body: text.slice(0, 300) };
  }
  const json = await res.json();
  return { ok: true, data: json };
}

export function upsertFxRatesFromFrankfurter(db, latest) {
  // { amount, base, date, rates: { EUR: 0.9, ... } } where 1 base = rate * other
  const base = String(latest.base ?? "USD").toUpperCase();
  const updatedAt = latest.date ? new Date(`${latest.date}T00:00:00Z`).toISOString() : new Date().toISOString();
  const rates = latest.rates && typeof latest.rates === "object" ? latest.rates : {};

  const upsert = db.prepare(`
    INSERT INTO fx_rates (from_currency, to_currency, rate, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(from_currency, to_currency) DO UPDATE SET
      rate = excluded.rate,
      updated_at = excluded.updated_at
  `);

  let count = 0;
  const tx = db.transaction(() => {
    upsert.run(base, base, 1, updatedAt);
    for (const [to, rateRaw] of Object.entries(rates)) {
      const toCcy = String(to).toUpperCase();
      const rate = Number(rateRaw);
      if (!toCcy || !Number.isFinite(rate) || rate <= 0) continue;
      upsert.run(base, toCcy, rate, updatedAt);
      count += 1;
    }
  });
  tx();

  return { base, updated_at: updatedAt, count };
}

export async function fetchCoinGeckoPrices({ ids, vsCurrency }) {
  const idsParam = Array.isArray(ids) ? ids.join(",") : String(ids ?? "");
  if (!idsParam) return { ok: false, error: "no_ids" };
  const vs = String(vsCurrency ?? "usd").toLowerCase();

  const url = new URL(`${COINGECKO_BASE_URL}/simple/price`);
  url.searchParams.set("ids", idsParam);
  url.searchParams.set("vs_currencies", vs);

  const res = await fetch(url.toString(), {
    headers: { "user-agent": "freetime-maker-shop-api/0.1.0" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: "http_error", status: res.status, body: text.slice(0, 300) };
  }
  const json = await res.json();
  return { ok: true, data: json };
}

export function upsertFxRatesFromCoinGecko(db, pricesById, { baseFiat }) {
  // pricesById: { bitcoin: { usd: 65000 }, ... }
  // We store baseFiat -> SYMBOL where SYMBOL is uppercased "BTC" style (best effort).
  const base = String(baseFiat ?? "USD").toUpperCase();
  const updatedAt = new Date().toISOString();

  const upsert = db.prepare(`
    INSERT INTO fx_rates (from_currency, to_currency, rate, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(from_currency, to_currency) DO UPDATE SET
      rate = excluded.rate,
      updated_at = excluded.updated_at
  `);

  const idToSymbol = {
    bitcoin: "BTC",
    ethereum: "ETH",
    litecoin: "LTC",
    solana: "SOL",
    binancecoin: "BNB",
    ripple: "XRP",
    cardano: "ADA",
    polkadot: "DOT",
    dogecoin: "DOGE",
    tron: "TRX",
    chainlink: "LINK",
    stellar: "XLM",
    monero: "XMR",
    toncoin: "TON",
    "shiba-inu": "SHIB",
    "avalanche-2": "AVAX",
    uniswap: "UNI",
    near: "NEAR",
    aptos: "APT",
    polygon: "MATIC",
    pepe: "PEPE",
    tether: "USDT",
    "usd-coin": "USDC",
  };

  let count = 0;
  const tx = db.transaction(() => {
    for (const [id, obj] of Object.entries(pricesById ?? {})) {
      const price = obj && typeof obj === "object" ? Number(obj.usd ?? obj[base.toLowerCase()]) : NaN;
      if (!Number.isFinite(price) || price <= 0) continue;
      const sym = idToSymbol[id] ?? String(id).toUpperCase();
      // CoinGecko: 1 COIN = price USD  =>  1 USD = (1/price) COIN
      upsert.run(base, sym, 1 / price, updatedAt);
      count += 1;
    }
    upsert.run(base, base, 1, updatedAt);
  });
  tx();

  return { base, updated_at: updatedAt, count };
}

