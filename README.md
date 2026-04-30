# Freetime-Maker-Shop-API
Offizielle API für den **Freetime Maker Shop** (Web + Android) — mit **Node.js (Fastify)**.

## Features (MVP)
- **Produkte**: `GET /products`, `GET /products/:sku`
- **News**: `GET /news`
- **Checkout / Bestellungen**: `POST /checkout` (optional mit `currency`), `GET /orders/:order_id`
- **Fulfillment (manuell)**: `POST /orders/:order_id/fulfill` (setzt z.B. einen Code, den du dann dem Käufer per E‑Mail senden kannst)
- **Support**: `POST /support/tickets`
- **Swagger/OpenAPI**: `GET /docs`

## Lokales Setup

```bash
npm install
npm run dev
```

Dann im Browser:
- Swagger UI: `http://localhost:8000/docs`
- Health: `http://localhost:8000/health`

## Konfiguration
Optional per Env-Var (oder `.env`, siehe `.env.example`):
- **`FMS_PORT`**: Default `8000`
- **`FMS_HOST`**: Default `0.0.0.0`
- **`FMS_DB_PATH`**: Default `./fms.db`
- **`FMS_CORS_ALLOW_ORIGINS`**: Default `*` (kommagetrennt möglich)
- **`FMS_ADMIN_TOKEN`**: aktiviert Admin-API (Header: `x-admin-token`)

## Echte Produkte (Bilder + mehrere Währungen)
Lege `data/products.json` an. Änderungen werden automatisch importiert (ohne Server-Neustart).

Siehe `data/products.schema.md` für das Format. Wichtig:
- **`images`**: Array mit Bild-URLs
- **`prices`**: Objekt mit Preisen pro Währung (Minor Units / Cent), z.B. `{ "USD": 1000, "EUR": 900 }`

Checkout kann eine Zielwährung setzen:

```json
{
  "email": "buyer@example.com",
  "currency": "EUR",
  "items": [{ "product_sku": "first-background", "quantity": 1 }]
}
```

## Kurswechsel (FX)
Wenn ein Produkt **keinen direkten Preis** in der gewünschten `currency` hat, kann die API (optional) über **FX-Kurse** umrechnen.

- **FX anzeigen**: `GET /fx/rates`
- **FX Status**: `GET /fx/status`
- **FX Symbole (inkl. alternative/crypto)**: `GET /fx/symbols`
- **FX setzen (Admin)**: `PUT /admin/fx/rates` (Header: `x-admin-token`)
- **FX Refresh (Admin)**: `POST /admin/fx/refresh` (lädt von OpenExchangeRates)

Beispiel (1 USD = 0.92 EUR):

```bash
curl -X PUT "http://localhost:8000/admin/fx/rates" \
  -H "x-admin-token: dein-geheimes-token" \
  -H "content-type: application/json" \
  -d '{ "from_currency": "USD", "to_currency": "EUR", "rate": 0.92 }'
```

## OpenExchangeRates (alle Währungen + alternative/digital)
Setze `FMS_OER_APP_ID` und (optional) den Refresh:
- **`FMS_OER_APP_ID`**: dein OpenExchangeRates `app_id`
- **`FMS_FX_REFRESH_SECONDS`**: z.B. `3600` (Default)
- **`FMS_FX_INCLUDE_ALTERNATIVE`**: `true` lädt `show_alternative=1` (inkl. digital/alternative Symbole, z.B. BTC/ETH/LTC – je nach OER-Verfügbarkeit/Plan)
Hinweis: **OpenExchangeRates funktioniert nicht ohne API-Key** (`app_id` ist Pflicht für `latest.json`).

## Ohne API-Keys (Default)
Standardmäßig läuft die FX-Schicht **ohne API-Keys**:
- **Fiat** über **Frankfurter/ECB** (`https://api.frankfurter.app`)
- **Crypto** über **CoinGecko** (kein Key; beachte Rate-Limits)

Konfiguration:
- **`FMS_FX_PROVIDER=no-key`** (Default)
- **`FMS_CRYPTO_IDS`**: Komma-Liste von CoinGecko-IDs, die importiert werden sollen (z.B. `bitcoin,ethereum,solana,tether,usd-coin`)

Hinweis: “Alle Crypto” (tausende Coins) ist ohne Key möglich, aber sehr schwergewichtig. Sinnvoll ist eine kuratierte Liste in `FMS_CRYPTO_IDS`.

## Hinweis zu Zahlungen
Dieses MVP erstellt Bestellungen und speichert den gewünschten `payment_provider`, integriert aber (noch) keine Provider-APIs.
