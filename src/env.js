import process from "node:process";
import dotenv from "dotenv";

dotenv.config();

export const env = {
  host: process.env.FMS_HOST ?? "0.0.0.0",
  port: Number(process.env.FMS_PORT ?? 8000),
  dbPath: process.env.FMS_DB_PATH ?? "./fms.db",
  corsAllowOrigins: process.env.FMS_CORS_ALLOW_ORIGINS ?? "*",
  adminToken: process.env.FMS_ADMIN_TOKEN ?? "",
  fxProvider: process.env.FMS_FX_PROVIDER ?? "no-key", // no-key | openexchangerates
  oerAppId: process.env.FMS_OER_APP_ID ?? "",
  fxAutoRefreshSeconds: Number(process.env.FMS_FX_REFRESH_SECONDS ?? 3600),
  fxIncludeAlternative: (process.env.FMS_FX_INCLUDE_ALTERNATIVE ?? "true").toLowerCase() !== "false",
  cryptoIds:
    process.env.FMS_CRYPTO_IDS ??
    "bitcoin,ethereum,litecoin,solana,binancecoin,ripple,cardano,polkadot,dogecoin,tron,chainlink,stellar,monero,toncoin,shiba-inu,avalanche-2,uniswap,near,aptos,polygon,pepe,tether,usd-coin",
};

