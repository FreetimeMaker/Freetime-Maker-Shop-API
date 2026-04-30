# Freetime Maker Shop API

## Overview
Official API for the Freetime Maker Shop (Web + Android), built with Node.js and Fastify. Provides endpoints for products, news, checkout/orders, fulfillment, support tickets, and FX/currency conversion. Includes Swagger UI for API exploration.

## Tech Stack
- **Runtime**: Node.js 20
- **Framework**: Fastify 5
- **Database**: SQLite (better-sqlite3) — stored in `./fms.db`
- **Validation**: Zod
- **API docs**: `@fastify/swagger` + `@fastify/swagger-ui` at `/docs`
- **CORS**: `@fastify/cors`

## Project Layout
- `src/server.js` — Main Fastify server with all routes
- `src/db.js` — SQLite open + migrations
- `src/seed.js` — Initial data seeding
- `src/env.js` — Environment variable loading
- `src/fx.js` — FX rate providers (Frankfurter, CoinGecko, OpenExchangeRates)
- `data/products.json` — Hot-reloadable product catalog
- `fms.db` — SQLite database (auto-created)

## Running in Replit
The workflow `Start application` runs `npm run dev` with `FMS_PORT=5000` and `FMS_HOST=0.0.0.0` so the API is exposed on Replit's public preview port.

- Health check: `/health`
- Swagger UI: `/docs`

## Configuration
Environment variables (see `.env.example`):
- `FMS_PORT` — server port (set to 5000 in the workflow for Replit preview)
- `FMS_HOST` — bind address (0.0.0.0 in Replit)
- `FMS_DB_PATH` — SQLite path (default `./fms.db`)
- `FMS_CORS_ALLOW_ORIGINS` — CORS origins (default `*`)
- `FMS_ADMIN_TOKEN` — enables `/admin/*` routes via `x-admin-token` header
- `FMS_FX_PROVIDER` — `no-key` (default) or `openexchangerates`
- `FMS_OER_APP_ID` — OpenExchangeRates app id (only when provider is `openexchangerates`)
- `FMS_FX_REFRESH_SECONDS` — FX auto-refresh interval (default 3600)
- `FMS_CRYPTO_IDS` — CoinGecko coin IDs to import

## Deployment
Configured for **VM** deployment target (because SQLite needs persistent local storage). Run command: `FMS_PORT=5000 FMS_HOST=0.0.0.0 npm start`.
