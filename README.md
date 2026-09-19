# 🐶 Dog Marketplace — Sample Stripe Connect Integration

A minimal Node.js + Express sample showing how a marketplace platform can:

1. **Onboard breeders and transporters** as Stripe connected accounts
   (Accounts V2 API) — same flow, different `role`
2. **Create puppies/dogs and transport routes** as Stripe Products
   (platform level)
3. **Sell puppies and book transport** through Stripe Checkout with a
   **destination charge** — the breeder/transporter gets paid, Dog
   Marketplace keeps an application fee (commission)
4. **Listen for webhooks** (thin events) when an account's requirements or
   capabilities change

Domain mapping: **connected account = breeder or transporter**,
**product = puppy or transport listing**,
**application fee = marketplace commission**.

> **Test mode only.** Use Stripe test keys and test cards (e.g. `4242 4242 4242 4242`).
> No real money moves here.

## Install

```bash
cd ~/workspace/dog-marketplace-connect
npm install
```

## Configure

```bash
cp .env.example .env
```

Edit `.env` and set:

| Variable                | What it is                                                              |
| ----------------------- | ----------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`     | Your Stripe **test** secret key (`sk_test_…`) from the Dashboard → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_…`) printed by `stripe listen` (see below)        |
| `APP_URL`               | Public URL of this app (default `http://localhost:4242`)                 |
| `APPLICATION_FEE_PERCENT` | Commission per sale or booking in percent (default `10`)          |
| `PORT`                  | Port to listen on (default `4242`)                                       |

The app boots without a key so you can view the pages, but every
Stripe-touching route fails fast with a helpful error until
`STRIPE_SECRET_KEY` is set.

## Run

```bash
npm start
```

Open http://localhost:4242.

## Forward webhooks (thin events)

Account requirement/capability changes arrive as **thin events**. While
developing, forward them to your local server with the Stripe CLI:

```bash
stripe listen --thin-events \
  'v2.core.account[requirements].updated,v2.core.account[.recipient].capability_status_updated' \
  --forward-thin-to localhost:4242/api/webhooks
```

Copy the printed `whsec_…` secret into `STRIPE_WEBHOOK_SECRET` in your `.env`,
then restart the app.

How it works in `server.js`:

1. The route uses `express.raw()` so Stripe's signature can be verified
   against the exact request bytes.
2. `stripe.parseEventNotification()` verifies the signature and parses the
   thin event (older SDKs called this `parseThinEvent`).
3. The full event is fetched via `stripe.v2.core.events.retrieve(id)`.
4. Handlers re-read the breeder's account **fresh from the API** and log the
   new `readyToReceivePayments` / `onboardingComplete` status.

## End-to-end test flow

1. **Create a breeder** — on the home page, fill in a kennel name + email and
   submit. This calls `POST /api/accounts` → `stripe.v2.core.accounts.create`
   with the platform-liable (`application` fees/losses) recipient configuration.
2. **Onboard the breeder** — click **Onboard to collect payments**. You'll be
   redirected to Stripe's hosted onboarding. In test mode, use Stripe's
   documented test values (e.g. `000-00-0000` style placeholders where asked).
   You'll return to `/?onboard=done`.
3. **Check status** — click **Check status**. It calls
   `GET /api/accounts/:id/status`, which retrieves the account with
   `include: ["configuration.recipient", "requirements"]` and reports
   `readyToReceivePayments` and `onboardingComplete` — always live from Stripe.
4. **List a puppy** — use the "List a puppy" form (name, description, price,
   breeder). This calls `POST /api/products` → `stripe.products.create`
   with `default_price_data`, storing the product → breeder mapping in
   `db.json` (and in the product's metadata).
5. **Buy the puppy** — click **Buy now**. This calls `POST /api/checkout`,
   which creates a hosted Checkout Session with `payment_intent_data`:
   `application_fee_amount` = your commission percent, and `transfer_data`
   → `destination` = the breeder's connected account. Pay with test card
   `4242 4242 4242 4242`.
6. **Watch the webhook** — complete a breeder's onboarding while
   `stripe listen` is running and you'll see the
   `v2.core.account[.recipient].capability_status_updated` event arrive at
   `/api/webhooks`.

## Transporter test flow (third side of the marketplace)

7. **Create a transporter** — on the home page, fill in a business name +
   email, choose **🚚 Transporter** in the "I am a…" dropdown, and submit.
   This calls `POST /api/accounts` with `role: "transporter"` → the exact
   same `stripe.v2.core.accounts.create` call as breeders (the `recipient`
   configuration with `stripe_transfers` is what lets any account receive
   payouts). The account is stored in `db.json` with `role: "transporter"`.
8. **Onboard the transporter** — click **Onboard to collect payments** on the
   transporter row and complete Stripe's hosted verification (same account-link
   flow as breeders). Click **Check status** to confirm
   `readyToReceivePayments` from the live API.
9. **List a transport route** — use the "Offer a transport route" form (service
   name, route like `Sacramento, CA → Los Angeles, CA`, description, price,
   transporter). This calls `POST /api/products` with
   `kind: "transport_listing"`, which validates that the chosen account has
   role `transporter`, then creates a platform-level product and stores the
   product → transporter mapping.
10. **Book the transport** — click **Book now** in the Pet transport section.
    This calls `POST /api/checkout` with the transport product: the buyer is
    charged on the platform, your `APPLICATION_FEE_PERCENT` commission stays
    with Dog Marketplace, and the rest transfers to the **transporter**.
    The success page reads the session's `metadata.kind` and says
    "transporter" instead of "breeder".

## API routes

| Method | Route                          | What it does                                              |
| ------ | ------------------------------ | --------------------------------------------------------- |
| GET    | `/`                            | Storefront: puppies, pet transport, onboarding, listing forms |
| GET    | `/success`                     | Post-checkout landing page (wording adapts to purchase vs booking) |
| POST   | `/api/accounts`                | Create a V2 connected account (`role`: `breeder` or `transporter`) |
| GET    | `/api/accounts`                | List known accounts (local index)                 |
| GET    | `/api/accounts/:id/onboard`    | Create a V2 account-onboarding link               |
| GET    | `/api/accounts/:id/status`     | Live onboarding status from the Stripe API        |
| POST   | `/api/products`                | Create a platform-level product (`kind`: `puppy_listing` or `transport_listing`; `route` required for transport) |
| GET    | `/api/products`                | List products (local index)                       |
| POST   | `/api/checkout`                | Hosted Checkout Session: destination charge + app fee (puppy purchase or transport booking) |
| POST   | `/api/webhooks`                | Thin-event webhook receiver (signature-verified)  |

## Notes & limits of this sample

- Storage is a local `db.json` file — fine for a demo, use a real database
  in production.
- Status is always read fresh from Stripe; `db.json` is only an index.
- Onboarding `refresh_url`/`return_url` use `APP_URL` — use a real
  `https://` URL (e.g. a Stripe CLI tunnel or deployed host) outside localhost.
- The SDK version is not pinned to an API preview; it sends a recent version
  automatically. If Stripe ever rejects a V2 call over API versioning, pass
  `{ apiVersion: '2026-08-26.dahlia' }` as the second `new Stripe()` argument.
- Before real money: complete live-mode onboarding/verification in the Stripe
  Dashboard and switch to a live secret key — only with explicit approval.
