/**
 * ============================================================================
 * Dog Marketplace — Sample Stripe Connect Integration
 * ----------------------------------------------------------------------------
 * A minimal Node.js + Express sample showing how a marketplace platform
 * (Dog Marketplace) can:
 *
 *   1. ONBOARD breeders AND transporters as Stripe connected accounts
 *      (Accounts V2 API) — the same flow serves both roles
 *   2. CREATE puppies/dogs AND transport routes as Stripe Products
 *      (platform level)
 *   3. SELL puppies and BOOK transport through Stripe Checkout using a
 *      DESTINATION CHARGE, where the breeder/transporter gets paid and the
 *      platform keeps an application fee (the marketplace commission).
 *   4. LISTEN for account requirement/capability changes via webhooks
 *      (thin events).
 *
 * Domain mapping used throughout this sample:
 *   - Stripe "connected account"  => a BREEDER (role "breeder") or a
 *                                    TRANSPORTER (role "transporter")
 *   - Stripe "product"            => a PUPPY / DOG listing (kind "puppy_listing")
 *                                    or a TRANSPORT listing (kind "transport_listing")
 *   - "application fee"          => Dog Marketplace's COMMISSION on the sale/booking
 *
 * TEST MODE ONLY. Never use real card details or a live secret key here.
 * ============================================================================
 */

'use strict';

// ---------------------------------------------------------------------------
// 1. Imports & environment
// ---------------------------------------------------------------------------
// dotenv loads variables from a local `.env` file into process.env so secrets
// stay out of the source code. See `.env.example` for the variables needed.
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

// ---------------------------------------------------------------------------
// 2. Configuration (all from environment — nothing secret is hardcoded)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 4242);
// APP_URL is the public address of THIS app. Stripe needs real URLs for
// onboarding refresh/return links and the Checkout success page, so when you
// go beyond localhost, set this to your https:// tunnel or deployed URL.
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
// Platform commission on every puppy sale, as a percent. 10 = 10%.
const FEE_PERCENT = Number(process.env.APPLICATION_FEE_PERCENT || 10);

// ---------------------------------------------------------------------------
// 3. Tiny JSON "database" (db.json)
// ---------------------------------------------------------------------------
// This sample has no real database, so we persist two small mappings in a
// local JSON file:
//   accounts: [{ id, displayName, email, role }]  — local user -> Stripe account ID
//             role is "breeder" (sells dogs) or "transporter" (moves dogs).
//             Entries written before the role field existed are treated as
//             "breeder".
//   products: [{ id, priceId, name, ..., connectedAccountId, kind, route }]
//             — Stripe product -> connected account ID that gets paid.
//             kind is "puppy_listing" (default) or "transport_listing";
//             route is the transport route (e.g. "Sacramento, CA → Los Angeles, CA")
//             and is only set on transport listings.
// In production use a real database. Webhook handlers and status checks
// ALWAYS re-read live state from the Stripe API; this file is only an index.
const DB_PATH = path.join(__dirname, 'db.json');

function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return {
      accounts: Array.isArray(db.accounts) ? db.accounts : [],
      products: Array.isArray(db.products) ? db.products : [],
    };
  } catch {
    return { accounts: [], products: [] }; // first run: start empty
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---------------------------------------------------------------------------
// 4. The Stripe Client — ONE client for every Stripe request
// ---------------------------------------------------------------------------
// The spec requires a single `stripeClient` used for all Stripe calls.
// We create it LAZILY (on first use) instead of at startup so the sample's
// web pages still render without a key, while every Stripe-touching route
// FAILS FAST with a helpful error the moment it is called.
//
// NEVER hardcode a secret key. NEVER commit one. Test keys start with sk_test_.
let stripeClient = null;

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const err = new Error(
      'STRIPE_SECRET_KEY is not set. ' +
        'Copy .env.example to .env and add your Stripe TEST secret key ' +
        '(it starts with sk_test_, from https://dashboard.stripe.com/test/apikeys).'
    );
    err.code = 'MISSING_STRIPE_KEY';
    err.status = 500;
    throw err;
  }
  if (!stripeClient) {
    // NOTE on API version: we intentionally do NOT pin `apiVersion` here —
    // the SDK sends a recent version automatically. The spec mentions the
    // 2026-08-26.dahlia preview; if Stripe ever rejects a V2 call because of
    // the API version, pass it explicitly:
    //   new Stripe(key, { apiVersion: '2026-08-26.dahlia' })
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

// Helper so the homepage can show a "key missing" banner without throwing.
function hasStripeKey() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

// ---------------------------------------------------------------------------
// 5. Express app & middleware
// ---------------------------------------------------------------------------
const app = express();

// Parse JSON request bodies for every route EXCEPT the webhook endpoint.
// The webhook must keep the EXACT raw request bytes for Stripe's signature
// verification, so it uses route-level express.raw() instead (see section 11).
// This middleware is registered before all routes so it applies to them.
app.use((req, res, next) => {
  if (req.path === '/api/webhooks' && req.method === 'POST') return next();
  return express.json()(req, res, next);
});

// Wrap async route handlers so rejected promises reach the error middleware
// instead of hanging the request.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Small HTML escaper — breeder names/emails are rendered into the page, so we
// escape them to avoid breaking markup (basic XSS hygiene for a sample).
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// 6. Shared onboarding-status logic (used by the status API AND webhooks)
// ---------------------------------------------------------------------------
// Always computed FRESH from the account object just retrieved from Stripe —
// never from the local db.json, per the spec.
function accountStatusSummary(account) {
  // The breeder can receive money once the `stripe_transfers` capability on
  // their `recipient` configuration is active.
  const readyToReceivePayments =
    account?.configuration?.recipient?.capabilities?.stripe_balance
      ?.stripe_transfers?.status === 'active';

  // Stripe reports the single most urgent requirement via
  // requirements.summary.minimum_deadline.status.
  const requirementsStatus =
    account.requirements?.summary?.minimum_deadline?.status || 'none';

  // Onboarding is done when nothing is currently due or past due.
  const onboardingComplete =
    requirementsStatus !== 'currently_due' && requirementsStatus !== 'past_due';

  return { readyToReceivePayments, onboardingComplete, requirementsStatus };
}

// ---------------------------------------------------------------------------
// 7. HTML — clean, simple, mobile-friendly, dog-marketplace themed
// ---------------------------------------------------------------------------

function pageShell(title, body) {
  return '<!DOCTYPE html>' +
    '<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + esc(title) + ' — Dog Marketplace</title>' +
    '<style>' +
    ':root{--bg:#FFF8F0;--card:#FFFFFF;--ink:#3B2A1E;--muted:#8A7360;' +
    '--accent:#E8912D;--accent-dark:#B5651D;--green:#1F8A4C;--amber:#B7791F;' +
    '--line:#F0E2D2;--radius:14px}' +
    '*{box-sizing:border-box}' +
    'body{margin:0;background:var(--bg);color:var(--ink);' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'line-height:1.5}' +
    '.wrap{max-width:760px;margin:0 auto;padding:20px 16px 60px}' +
    'header.hero{text-align:center;padding:28px 12px 8px}' +
    'header.hero .paw{font-size:44px}' +
    'h1{margin:8px 0 4px;font-size:28px}' +
    '.tag{color:var(--muted);margin:0 0 8px}' +
    '.card{background:var(--card);border:1px solid var(--line);' +
    'border-radius:var(--radius);padding:18px;margin:16px 0;' +
    'box-shadow:0 2px 8px rgba(180,120,60,.06)}' +
    'h2{margin:0 0 6px;font-size:20px}' +
    'h2 .em{margin-right:6px}' +
    'p.hint{color:var(--muted);font-size:14px;margin:6px 0 12px}' +
    'label{display:block;font-size:14px;font-weight:600;margin:10px 0 4px}' +
    'input,select,textarea{width:100%;padding:10px 12px;font-size:16px;' +
    'border:1px solid var(--line);border-radius:10px;background:#FFFEFB}' +
    '.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
    '@media(max-width:520px){.row{grid-template-columns:1fr}}' +
    'button,.btn{display:inline-block;border:0;cursor:pointer;' +
    'background:var(--accent);color:#fff;font-weight:700;font-size:16px;' +
    'padding:11px 18px;border-radius:10px;margin-top:12px;text-decoration:none}' +
    'button:hover,.btn:hover{background:var(--accent-dark)}' +
    'button.ghost{background:#fff;color:var(--accent-dark);' +
    'border:1px solid var(--accent)}' +
    'button.small{font-size:14px;padding:8px 12px;margin:6px 6px 0 0}' +
    '.notice{border-radius:10px;padding:12px 14px;margin:12px 0;font-size:14px}' +
    '.notice.warn{background:#FFF3D6;border:1px solid #F0D48A;color:#7A5410}' +
    '.notice.ok{background:#E4F6EA;border:1px solid #9ADBB2;color:#14532D}' +
    '.notice.info{background:#EAF2FD;border:1px solid #B9D0F5;color:#1E3F7A}' +
    '.puppy{display:flex;gap:14px;align-items:center;' +
    'border:1px solid var(--line);border-radius:12px;padding:12px;margin:10px 0}' +
    '.puppy .face{font-size:38px;flex:0 0 auto}' +
    '.puppy .meta{flex:1;min-width:0}' +
    '.puppy .name{font-weight:700;font-size:17px}' +
    '.puppy .sub{color:var(--muted);font-size:14px}' +
    '.puppy .price{font-weight:800;font-size:18px;white-space:nowrap}' +
    '.acct{border:1px solid var(--line);border-radius:12px;padding:12px;margin:10px 0}' +
    '.acct .who{font-weight:700}' +
    '.acct .mail{color:var(--muted);font-size:13px;word-break:break-all}' +
    '.acct .id{font-family:monospace;font-size:12px;color:var(--muted)}' +
    '.badge{display:inline-block;font-size:12px;font-weight:700;' +
    'padding:3px 10px;border-radius:999px;margin:4px 6px 0 0}' +
    '.badge.green{background:#E4F6EA;color:var(--green)}' +
    '.badge.amber{background:#FFF3D6;color:var(--amber)}' +
    '.badge.grey{background:#F1ECE6;color:var(--muted)}' +
    'footer{text-align:center;color:var(--muted);font-size:13px;margin-top:28px}' +
    'code{background:#F6EFE6;padding:2px 6px;border-radius:6px;font-size:13px}' +
    '</style></head>' +
    '<body><div class="wrap">' +
    '<header class="hero"><div class="paw">🐶</div>' +
    '<h1>Dog Marketplace</h1>' +
    '<p class="tag">Sample Stripe Connect integration — breeders &amp; transporters get paid, the marketplace earns a commission.</p>' +
    '</header>' +
    body +
    '<footer>Sample integration for testing &amp; learning. Test mode only — no real money moves here. 🐾</footer>' +
    '</div>' +
    // ---- Client-side JS (plain quotes only; no nested template literals) ----
    '<script>' +
    'function postJSON(url, data){' +
    'return fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},' +
    'body:JSON.stringify(data)}).then(function(r){return r.json().then(function(j){' +
    'return {ok:r.ok, status:r.status, json:j};});});}' +
    'function showErr(msg){alert("Error: " + msg);}' +
    // Account signup form -> POST /api/accounts (breeders AND transporters).
    // The form carries a "role" select; the server defaults to "breeder".
    'var breederForm = document.getElementById("breeder-form");' +
    'if (breederForm) { breederForm.addEventListener("submit", function(e){' +
    'e.preventDefault();' +
    'var fd = new FormData(breederForm);' +
    'postJSON("/api/accounts",{display_name:fd.get("display_name"),' +
    'contact_email:fd.get("contact_email"),role:fd.get("role")}).then(function(r){' +
    'if(!r.ok){showErr(r.json.error || ("HTTP "+r.status));return;}' +
    'window.location.reload();});});}' +
    // "Onboard to collect payments" buttons -> GET /api/accounts/:id/onboard
    'document.querySelectorAll("[data-onboard]").forEach(function(btn){' +
    'btn.addEventListener("click", function(){' +
    'btn.disabled = true; btn.textContent = "Opening Stripe…";' +
    'fetch("/api/accounts/"+encodeURIComponent(btn.getAttribute("data-onboard"))+"/onboard")' +
    '.then(function(r){return r.json().then(function(j){return {ok:r.ok,json:j};});})' +
    '.then(function(r){' +
    'if(!r.ok || !r.json.url){showErr((r.json&&r.json.error)||"Could not create onboarding link.");' +
    'btn.disabled=false;btn.textContent="Onboard to collect payments";return;}' +
    'window.location.href = r.json.url;});});});' +
    // "Check status" buttons -> GET /api/accounts/:id/status (always fresh from Stripe)
    'document.querySelectorAll("[data-status]").forEach(function(btn){' +
    'btn.addEventListener("click", function(){' +
    'var id = btn.getAttribute("data-status");' +
    'var box = document.getElementById("status-"+id);' +
    'box.innerHTML = "<span class=\\"badge grey\\">Checking with Stripe…</span>";' +
    'fetch("/api/accounts/"+encodeURIComponent(id)+"/status")' +
    '.then(function(r){return r.json().then(function(j){return {ok:r.ok,json:j};});})' +
    '.then(function(r){' +
    'if(!r.ok){box.innerHTML="<span class=\\"badge amber\\">Error</span> "+' +
    '((r.json&&r.json.error)||"request failed");return;}' +
    'var s = r.json;' +
    'var html = s.readyToReceivePayments ' +
    '? "<span class=\\"badge green\\">✅ Can receive payouts</span>" ' +
    ': "<span class=\\"badge amber\\">⏳ Payouts not active yet</span>";' +
    'html += s.onboardingComplete ' +
    '? "<span class=\\"badge green\\">✅ Onboarding complete</span>" ' +
    ': "<span class=\\"badge amber\\">📝 Onboarding needs attention</span>";' +
    'html += "<div class=\\"acct mail\\" style=\\"margin-top:6px\\">Requirements: "+s.requirementsStatus+"</div>";' +
    'box.innerHTML = html;});});});' +
    // Puppy listing form -> POST /api/products (kind defaults to puppy_listing,
    // sent explicitly here for clarity)
    'var puppyForm = document.getElementById("puppy-form");' +
    'if (puppyForm) { puppyForm.addEventListener("submit", function(e){' +
    'e.preventDefault();' +
    'var fd = new FormData(puppyForm);' +
    'postJSON("/api/products",{kind:"puppy_listing",name:fd.get("name"),description:fd.get("description"),' +
    'price_dollars:fd.get("price_dollars"),currency:"usd",' +
    'connected_account_id:fd.get("connected_account_id")}).then(function(r){' +
    'if(!r.ok){showErr(r.json.error || ("HTTP "+r.status));return;}' +
    'window.location.reload();});});}' +
    // Transport listing form -> POST /api/products with kind "transport_listing".
    // Same platform-product pattern as puppies; the transporter's account ID
    // is stored alongside so booking checkout knows the payout destination.
    'var transportForm = document.getElementById("transport-form");' +
    'if (transportForm) { transportForm.addEventListener("submit", function(e){' +
    'e.preventDefault();' +
    'var fd = new FormData(transportForm);' +
    'postJSON("/api/products",{kind:"transport_listing",name:fd.get("name"),' +
    'description:fd.get("description"),route:fd.get("route"),' +
    'price_dollars:fd.get("price_dollars"),currency:"usd",' +
    'connected_account_id:fd.get("connected_account_id")}).then(function(r){' +
    'if(!r.ok){showErr(r.json.error || ("HTTP "+r.status));return;}' +
    'window.location.reload();});});}' +
    // Buy buttons -> POST /api/checkout -> redirect to hosted Checkout
    'document.querySelectorAll("[data-buy]").forEach(function(btn){' +
    'btn.addEventListener("click", function(){' +
    'btn.disabled = true; btn.textContent = "Starting checkout…";' +
    'postJSON("/api/checkout",{product_id:btn.getAttribute("data-buy")})' +
    '.then(function(r){' +
    'if(!r.ok || !r.json.url){showErr((r.json&&r.json.error)||"Could not start checkout.");' +
    'btn.disabled=false;btn.textContent="Buy now";return;}' +
    'window.location.href = r.json.url;});});});' +
    // Book buttons -> POST /api/checkout -> redirect to hosted Checkout.
    // Booking is the SAME destination-charge flow as buying a puppy: the buyer
    // is charged on the platform, the application fee stays with the
    // marketplace, and the rest is transferred to the TRANSPORTER's connected
    // account. Only the button label differs.
    'document.querySelectorAll("[data-book]").forEach(function(btn){' +
    'btn.addEventListener("click", function(){' +
    'btn.disabled = true; btn.textContent = "Starting booking…";' +
    'postJSON("/api/checkout",{product_id:btn.getAttribute("data-book")})' +
    '.then(function(r){' +
    'if(!r.ok || !r.json.url){showErr((r.json&&r.json.error)||"Could not start checkout.");' +
    'btn.disabled=false;btn.textContent="Book now";return;}' +
    'window.location.href = r.json.url;});});});' +
    '</script>' +
    '</body></html>';
}

// ---------------------------------------------------------------------------
// 8. Home page — storefront + breeder onboarding + puppy listing forms
// ---------------------------------------------------------------------------
function homePage(query) {
  const db = loadDb();
  const keyOk = hasStripeKey();
  let html = '';

  // Banner when no key is configured: pages still render, Stripe calls fail
  // fast with a helpful error (see getStripe()).
  if (!keyOk) {
    html += '<div class="notice warn">⚠️ <b>STRIPE_SECRET_KEY is not set.</b> ' +
      'Pages will render, but creating accounts, products, or checkouts will ' +
      'return a helpful error. Copy <code>.env.example</code> to <code>.env</code> ' +
      'and add your test key to go further.</div>';
  }

  // Friendly notices when Stripe redirects back from onboarding.
  if (query.onboard === 'done') {
    html += '<div class="notice ok">🎉 Onboarding finished (or skipped). ' +
      'Click <b>Check status</b> below to read the live status from Stripe.</div>';
  } else if (query.onboard === 'refresh') {
    html += '<div class="notice info">↩️ Onboarding was interrupted. ' +
      'Click <b>Onboard to collect payments</b> again to continue where you left off.</div>';
  }

  // Split products by kind for the two storefront sections. Products written
  // before the kind field existed default to "puppy_listing".
  const puppies = db.products.filter(function (p) {
    return (p.kind || 'puppy_listing') === 'puppy_listing';
  });
  const transports = db.products.filter(function (p) {
    return p.kind === 'transport_listing';
  });
  // Split accounts by role; legacy entries without a role are breeders.
  const breeders = db.accounts.filter(function (a) { return (a.role || 'breeder') === 'breeder'; });
  const transporters = db.accounts.filter(function (a) { return a.role === 'transporter'; });

  function roleBadge(a) {
    return (a.role || 'breeder') === 'transporter'
      ? '<span class="badge amber">🚚 Transporter</span>'
      : '<span class="badge green">🧑‍🌾 Breeder</span>';
  }

  // ---- Storefront: every puppy product, each linked to its breeder ----
  html += '<div class="card"><h2><span class="em">🏪</span> Puppies for sale</h2>' +
    '<p class="hint">Buying sends money to the breeder’s connected account; ' +
    'Dog Marketplace keeps a ' + FEE_PERCENT + '% commission automatically.</p>';
  if (puppies.length === 0) {
    html += '<p class="hint">No puppies listed yet — add the first one below! 🐾</p>';
  }
  puppies.forEach(function (p) {
    const breeder = db.accounts.find(function (a) { return a.id === p.connectedAccountId; });
    html += '<div class="puppy"><div class="face">🐕</div>' +
      '<div class="meta"><div class="name">' + esc(p.name) + '</div>' +
      '<div class="sub">' + esc(p.description || 'A very good dog') + '<br>Breeder: ' +
      esc(breeder ? breeder.displayName : p.connectedAccountId) + '</div></div>' +
      '<div><div class="price">$' + (p.unitAmount / 100).toFixed(2) + '</div>' +
      '<button class="small" data-buy="' + esc(p.id) + '">Buy now</button></div></div>';
  });
  html += '</div>';

  // ---- Storefront: pet transport — the third side of the marketplace ----
  // Transporters list routes they drive; booking one charges the buyer on the
  // platform, keeps the same commission, and transfers the rest to the
  // TRANSPORTER's connected account (same destination-charge pattern).
  html += '<div class="card"><h2><span class="em">🚚</span> Pet transport</h2>' +
    '<p class="hint">Booking sends money to the transporter’s connected account; ' +
    'Dog Marketplace keeps a ' + FEE_PERCENT + '% commission automatically.</p>';
  if (transports.length === 0) {
    html += '<p class="hint">No transport routes listed yet — transporters can add the first one below! 🗺️</p>';
  }
  transports.forEach(function (t) {
    const transporter = db.accounts.find(function (a) { return a.id === t.connectedAccountId; });
    html += '<div class="puppy"><div class="face">🚚</div>' +
      '<div class="meta"><div class="name">' + esc(t.name) + '</div>' +
      '<div class="sub">' + esc(t.route || '') +
      (t.description ? '<br>' + esc(t.description) : '') +
      '<br>Transporter: ' + esc(transporter ? transporter.displayName : t.connectedAccountId) + '</div></div>' +
      '<div><div class="price">$' + (t.unitAmount / 100).toFixed(2) + '</div>' +
      '<button class="small" data-book="' + esc(t.id) + '">Book now</button></div></div>';
  });
  html += '</div>';

  // ---- Account onboarding: breeders AND transporters ----
  // Both roles use the EXACT same V2 account creation + Stripe-hosted
  // onboarding flow; the "role" only decides which listings they can create
  // (puppies vs transport routes) and which dropdown they appear in below.
  html += '<div class="card"><h2><span class="em">🧑‍🌾</span> For breeders &amp; transporters</h2>' +
    '<p class="hint">Step 1: create your connected account. Step 2: click ' +
    '“Onboard to collect payments” and complete Stripe’s verification.</p>' +
    '<form id="breeder-form"><div class="row">' +
    '<div><label for="display_name">Business / display name</label>' +
    '<input id="display_name" name="display_name" placeholder="Happy Tails Kennel" required></div>' +
    '<div><label for="contact_email">Email</label>' +
    '<input id="contact_email" name="contact_email" type="email" placeholder="you@example.com" required></div>' +
    '</div><label for="role">I am a…</label>' +
    '<select id="role" name="role">' +
    '<option value="breeder">🧑‍🌾 Breeder — I sell dogs</option>' +
    '<option value="transporter">🚚 Transporter — I move dogs</option>' +
    '</select>' +
    '<button type="submit">Create account</button></form>';

  if (db.accounts.length === 0) {
    html += '<p class="hint">No accounts yet.</p>';
  }
  db.accounts.forEach(function (a) {
    html += '<div class="acct"><div class="who">' + esc(a.displayName) + ' ' + roleBadge(a) + '</div>' +
      '<div class="mail">' + esc(a.email) + '</div>' +
      '<div class="id">' + esc(a.id) + '</div>' +
      '<div id="status-' + esc(a.id) + '"></div>' +
      '<button class="small" data-onboard="' + esc(a.id) + '">Onboard to collect payments</button>' +
      '<button class="small ghost" data-status="' + esc(a.id) + '">Check status</button></div>';
  });
  html += '</div>';

  // ---- Puppy listing form (creates a platform-level product) ----
  html += '<div class="card"><h2><span class="em">📝</span> List a puppy</h2>' +
    '<p class="hint">Creates a Stripe Product owned by the <b>platform</b>; ' +
    'the chosen breeder’s account ID is stored alongside it so checkout knows ' +
    'where to send the money.</p>';
  if (breeders.length === 0) {
    html += '<p class="hint">Create a breeder account first — a puppy needs someone to pay!</p>';
  } else {
    html += '<form id="puppy-form">' +
      '<label for="pname">Puppy name</label>' +
      '<input id="pname" name="name" placeholder="Biscuit" required>' +
      '<label for="pdesc">Breed / description</label>' +
      '<input id="pdesc" name="description" placeholder="Golden Retriever, 8 weeks old, vet-checked">' +
      '<div class="row"><div><label for="pprice">Price (USD)</label>' +
      '<input id="pprice" name="price_dollars" type="number" min="1" step="0.01" placeholder="1200" required></div>' +
      '<div><label for="pbreeder">Breeder (gets paid)</label>' +
      '<select id="pbreeder" name="connected_account_id" required>';
    breeders.forEach(function (a) {
      html += '<option value="' + esc(a.id) + '">' + esc(a.displayName) + '</option>';
    });
    html += '</select></div></div>' +
      '<button type="submit">List this puppy</button></form>';
  }
  html += '</div>';

  // ---- Transport listing form (platform-level product for a transporter) ----
  // Same Stripe pattern as puppies: the Product is owned by the platform and
  // the transporter's account ID travels alongside it (metadata + db.json).
  // Only accounts with role "transporter" appear in the dropdown.
  html += '<div class="card"><h2><span class="em">🗺️</span> Offer a transport route</h2>' +
    '<p class="hint">Creates a Stripe Product owned by the <b>platform</b>; ' +
    'the chosen transporter’s account ID is stored alongside it so booking ' +
    'checkout knows where to send the money.</p>';
  if (transporters.length === 0) {
    html += '<p class="hint">Create a transporter account above first — ' +
      'a route needs someone to get paid for it!</p>';
  } else {
    html += '<form id="transport-form">' +
      '<label for="tname">Service name</label>' +
      '<input id="tname" name="name" placeholder="Weekly puppy run — NorCal to SoCal" required>' +
      '<label for="troute">Route</label>' +
      '<input id="troute" name="route" placeholder="Sacramento, CA → Los Angeles, CA" required>' +
      '<label for="tdesc">Description</label>' +
      '<input id="tdesc" name="description" placeholder="Climate-controlled van, 1–2 day delivery, GPS updates">' +
      '<div class="row"><div><label for="tprice">Price per booking (USD)</label>' +
      '<input id="tprice" name="price_dollars" type="number" min="1" step="0.01" placeholder="250" required></div>' +
      '<div><label for="ttransporter">Transporter (gets paid)</label>' +
      '<select id="ttransporter" name="connected_account_id" required>';
    transporters.forEach(function (a) {
      html += '<option value="' + esc(a.id) + '">' + esc(a.displayName) + '</option>';
    });
    html += '</select></div></div>' +
      '<button type="submit">List this route</button></form>';
  }
  html += '</div>';

  return pageShell('Connect demo', html);
}

// ---------------------------------------------------------------------------
// 9. Success page — buyer lands here after paying (puppy OR transport booking)
// ---------------------------------------------------------------------------
function successPage(sessionId, amountText, kind) {
  // kind comes from the Checkout Session metadata set in POST /api/checkout.
  const isTransport = kind === 'transport_listing';
  const payee = isTransport ? 'transporter' : 'breeder';
  const action = isTransport ? 'booking' : 'purchase';
  const body =
    '<div class="card" style="text-align:center">' +
    '<div style="font-size:52px">🎉</div>' +
    '<h2>Payment successful!</h2>' +
    (amountText
      ? '<p>Thanks for your ' + action + ' of <b>' + esc(amountText) + '</b>.</p>'
      : '<p>Thanks for your ' + action + '!</p>') +
    '<p class="hint">The ' + payee + ' has been paid via their connected account and ' +
    'Dog Marketplace kept its commission automatically. 🐾</p>' +
    (sessionId
      ? '<p class="hint">Checkout session: <code>' + esc(sessionId) + '</code></p>'
      : '') +
    '<a class="btn" href="/">Back to the marketplace</a></div>';
  return pageShell('Payment successful', body);
}

// ---------------------------------------------------------------------------
// 10. API ROUTES
// ---------------------------------------------------------------------------

// ---- Storefront & success pages -------------------------------------------
app.get('/', (req, res) => {
  // Pure HTML from the local JSON index — no Stripe call needed, so this
  // renders even before STRIPE_SECRET_KEY is configured.
  res.send(homePage(req.query));
});

app.get('/success', ah(async (req, res) => {
  // Buyer returns here from hosted Checkout. We best-effort fetch the session
  // to show what was paid (and whether it was a puppy purchase or a transport
  // booking, from the metadata kind set at checkout time); if that fails we
  // still show a friendly page.
  const sessionId = req.query.session_id;
  let amountText = null;
  let kind = 'puppy_listing';
  if (sessionId && hasStripeKey()) {
    try {
      const session = await getStripe().checkout.sessions.retrieve(String(sessionId));
      if (session.amount_total != null) {
        amountText =
          (session.amount_total / 100).toFixed(2) + ' ' +
          String(session.currency || 'usd').toUpperCase();
      }
      if (session.metadata && session.metadata.kind) {
        kind = session.metadata.kind;
      }
    } catch (e) {
      console.warn('[success] could not retrieve session:', e.message);
    }
  }
  res.send(successPage(sessionId ? String(sessionId) : null, amountText, kind));
}));

// ---- Connected accounts (breeders) ----------------------------------------

// POST /api/accounts — create a V2 connected account for a breeder OR a transporter.
// Body: { display_name, contact_email, role? }  — role is "breeder" (default) or "transporter".
app.post('/api/accounts', ah(async (req, res) => {
  const stripe = getStripe(); // throws a helpful error if STRIPE_SECRET_KEY is missing

  const displayName = String(req.body.display_name || '').trim();
  const contactEmail = String(req.body.contact_email || '').trim();
  if (!displayName || !contactEmail) {
    return res
      .status(400)
      .json({ error: 'display_name and contact_email are required.' });
  }

  // The marketplace role: "breeder" sells dogs, "transporter" moves them.
  // Transporters go through the EXACT same V2 account creation and the same
  // account-link onboarding as breeders — the `recipient` configuration with
  // the stripe_transfers capability is what lets ANY account receive payouts,
  // whether they're paid for puppies or for transport bookings.
  const role = String(req.body.role || 'breeder').toLowerCase();
  if (role !== 'breeder' && role !== 'transporter') {
    return res
      .status(400)
      .json({ error: 'role must be "breeder" or "transporter".' });
  }

  // Create the connected account with the V2 API, using EXACTLY the properties
  // from the spec. Important details:
  //  - The platform is responsible for pricing and fee collection, expressed
  //    via defaults.responsibilities (fees_collector/losses_collector).
  //  - We request the `recipient` configuration with the stripe_transfers
  //    capability so this breeder can RECEIVE payouts/transfers.
  //  - `dashboard: 'express'` gives the breeder Stripe's hosted Express
  //    dashboard (works only when the application collects fees+losses).
  //  - NEVER pass a top-level `type` ('express' | 'standard' | 'custom') —
  //    V2 accounts don't use it.
  const account = await stripe.v2.core.accounts.create({
    display_name: displayName, // from the breeder (the "user")
    contact_email: contactEmail, // from the breeder
    identity: {
      country: 'us', // all breeders are US-based in this sample
    },
    dashboard: 'express',
    defaults: {
      responsibilities: {
        fees_collector: 'application',
        losses_collector: 'application',
      },
    },
    configuration: {
      recipient: {
        capabilities: {
          stripe_balance: {
            stripe_transfers: {
              requested: true,
            },
          },
        },
      },
    },
  });

  // Persist the mapping: local user (kennel or transport company) -> Stripe
  // account ID, including their marketplace role.
  const db = loadDb();
  db.accounts.push({
    id: account.id,
    displayName,
    email: contactEmail,
    role, // "breeder" | "transporter"
    createdAt: new Date().toISOString(),
  });
  saveDb(db);

  res.status(201).json({ id: account.id, displayName, email: contactEmail, role });
}));

// GET /api/accounts — list known accounts (breeders and transporters; local index only).
app.get('/api/accounts', (req, res) => {
  res.json(loadDb().accounts);
});

// GET /api/accounts/:id/onboard — build a Stripe-hosted onboarding link.
// The UI calls this when the breeder clicks "Onboard to collect payments".
app.get('/api/accounts/:id/onboard', ah(async (req, res) => {
  const stripe = getStripe();
  const accountId = req.params.id;

  // V2 account links API. The `account_onboarding` use case walks the breeder
  // through identity verification and payout details on stripe.com.
  // `configurations: ['recipient']` must match the configuration requested
  // when the account was created.
  const accountLink = await stripe.v2.core.accountLinks.create({
    account: accountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        configurations: ['recipient'],
        // Where Stripe sends the breeder if they abandon the flow (they can resume).
        refresh_url: `${APP_URL}/?onboard=refresh&account=${accountId}`,
        // Where Stripe sends the breeder when they finish.
        // NOTE: use real https:// URLs in production; localhost is fine for testing.
        return_url: `${APP_URL}/?onboard=done&account=${accountId}`,
      },
    },
  });

  // The link is single-use and short-lived — redirect the breeder immediately.
  res.json({ url: accountLink.url });
}));

// GET /api/accounts/:id/status — live onboarding status, ALWAYS fresh from the
// Stripe API (never from db.json), exactly as the spec requires.
app.get('/api/accounts/:id/status', ah(async (req, res) => {
  const stripe = getStripe();
  const accountId = req.params.id;

  // `include` tells the V2 API to populate these normally-omitted sub-objects
  // so we can read capability + requirement state in one call.
  const account = await stripe.v2.core.accounts.retrieve(accountId, {
    include: ['configuration.recipient', 'requirements'],
  });

  res.json({ accountId, ...accountStatusSummary(account) });
}));

// ---- Products (puppies AND transport listings) — created at the PLATFORM level ----

// POST /api/products — create a platform-owned product for a puppy OR a transport listing.
// Body: { name, description, price_dollars, currency?, connected_account_id, kind?, route? }
//   kind: "puppy_listing" (default) or "transport_listing".
//   route: required for transport listings (e.g. "Sacramento, CA → Los Angeles, CA").
app.post('/api/products', ah(async (req, res) => {
  const stripe = getStripe();

  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  const priceDollars = Number(req.body.price_dollars);
  const currency = String(req.body.currency || 'usd').toLowerCase();
  const connectedAccountId = String(req.body.connected_account_id || '').trim();
  const kind = String(req.body.kind || 'puppy_listing');
  const route = String(req.body.route || '').trim();

  if (kind !== 'puppy_listing' && kind !== 'transport_listing') {
    return res
      .status(400)
      .json({ error: 'kind must be "puppy_listing" or "transport_listing".' });
  }
  if (!name) return res.status(400).json({ error: 'name is required.' });
  if (kind === 'transport_listing' && !route) {
    return res
      .status(400)
      .json({ error: 'route is required for transport listings.' });
  }
  if (!Number.isFinite(priceDollars) || priceDollars <= 0) {
    return res.status(400).json({ error: 'price_dollars must be a positive number.' });
  }
  if (!connectedAccountId) {
    return res.status(400).json({ error: 'connected_account_id is required.' });
  }

  // The listing's kind must match the account's role: breeders sell puppies,
  // transporters sell transport. (Accounts written before the role field
  // existed are treated as breeders.)
  const db = loadDb();
  const account = db.accounts.find((a) => a.id === connectedAccountId);
  if (!account) {
    return res.status(400).json({
      error: `Unknown connected_account_id ${connectedAccountId}. Create the account first.`,
    });
  }
  const accountRole = account.role || 'breeder';
  if (kind === 'puppy_listing' && accountRole === 'transporter') {
    return res.status(400).json({
      error: `${connectedAccountId} is a transporter account — puppy listings need a breeder account.`,
    });
  }
  if (kind === 'transport_listing' && accountRole !== 'transporter') {
    return res.status(400).json({
      error: `${connectedAccountId} is a breeder account — transport listings need a transporter account.`,
    });
  }

  const unitAmount = Math.round(priceDollars * 100); // Stripe wants integer cents

  // Products live on the PLATFORM (not on the connected account). We record
  // which account this listing belongs to — plus its kind and route — in
  // `metadata` AND in db.json, so checkout knows the transfer destination.
  const product = await stripe.products.create({
    name,
    description: description || undefined,
    default_price_data: {
      unit_amount: unitAmount,
      currency,
    },
    metadata: {
      connected_account_id: connectedAccountId,
      kind,
      ...(kind === 'transport_listing' ? { route } : {}),
    },
  });

  db.products.push({
    id: product.id,
    priceId: product.default_price, // the Price created via default_price_data
    name,
    description,
    kind,
    ...(kind === 'transport_listing' ? { route } : {}),
    unitAmount,
    currency,
    connectedAccountId,
    createdAt: new Date().toISOString(),
  });
  saveDb(db);

  res.status(201).json({
    id: product.id,
    priceId: product.default_price,
    name,
    kind,
    ...(kind === 'transport_listing' ? { route } : {}),
    unitAmount,
    currency,
    connectedAccountId,
  });
}));

// GET /api/products — list puppy + transport products (local index; no Stripe call).
app.get('/api/products', (req, res) => {
  res.json(loadDb().products);
});

// ---- Checkout — destination charge with platform commission ----------------
// Used for BOTH puppy purchases and transport bookings: the only difference
// is which connected account the money is transferred to (breeder vs
// transporter). The application fee percent is the same for both.

// POST /api/checkout — start a hosted Checkout Session for one puppy OR one
// transport booking.
// Body: { product_id }
app.post('/api/checkout', ah(async (req, res) => {
  const stripe = getStripe();

  const productId = String(req.body.product_id || '').trim();
  const item = loadDb().products.find((p) => p.id === productId);
  if (!item) {
    return res.status(404).json({ error: `Unknown product_id ${productId}.` });
  }

  // The marketplace commission: APPLICATION_FEE_PERCENT of the puppy's price.
  // application_fee_amount is in the same integer-cents unit as the price.
  const applicationFeeAmount = Math.round((item.unitAmount * FEE_PERCENT) / 100);
  if (applicationFeeAmount <= 0 || applicationFeeAmount >= item.unitAmount) {
    return res.status(400).json({
      error: `Misconfigured commission: ${FEE_PERCENT}% of ${item.unitAmount}c is not a valid fee.`,
    });
  }

  // Destination charge: the buyer is charged on the PLATFORM, Stripe keeps
  // `application_fee_amount` for Dog Marketplace, and the rest is transferred
  // to the connected account automatically — a breeder for puppies, a
  // transporter for bookings. Hosted Checkout means Stripe renders the whole
  // payment page — no card UI to build.
  const session = await stripe.checkout.sessions.create({
    line_items: [
      {
        price: item.priceId, // the Price created with the product
        quantity: 1,
      },
    ],
    payment_intent_data: {
      application_fee_amount: applicationFeeAmount, // <-- our commission
      transfer_data: {
        destination: item.connectedAccountId, // <-- breeder or transporter gets the rest
      },
    },
    mode: 'payment',
    // Remember what kind of listing this was so /success can say
    // "transporter" instead of "breeder" for bookings.
    metadata: {
      kind: item.kind || 'puppy_listing',
    },
    success_url: `${APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/`,
  });

  res.json({ url: session.url });
}));

// ---------------------------------------------------------------------------
// 11. WEBHOOKS — thin events for connected-account requirement/capability changes
// ---------------------------------------------------------------------------
// Requirements change over time (regulators, card networks, …). Stripe notifies
// us with THIN events: tiny unversioned payloads that only reference the
// changed object. We verify the signature, then fetch the full event.
//
// Forward events locally while developing with the Stripe CLI:
//   stripe listen --thin-events \
//     'v2.core.account[requirements].updated,v2.core.account[.recipient].capability_status_updated' \
//     --forward-thin-to localhost:4242/api/webhooks
//
// NOTE: this route is registered with route-level express.raw() and the global
// JSON parser skips it (see section 5), because signature verification needs
// the EXACT raw bytes Stripe sent.
app.post(
  '/api/webhooks',
  express.raw({ type: 'application/json' }),
  ah(async (req, res) => {
    const stripe = getStripe();

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      const err = new Error(
        'STRIPE_WEBHOOK_SECRET is not set. Run the `stripe listen` command ' +
          'from the README (with --thin-events) and copy the printed whsec_… ' +
          'secret into your .env file.'
      );
      err.code = 'MISSING_WEBHOOK_SECRET';
      err.status = 500;
      throw err;
    }

    const signature = req.headers['stripe-signature'];
    if (!signature) {
      return res
        .status(400)
        .json({ error: 'Missing stripe-signature header. Are you sending this from Stripe?' });
    }

    // Verify the signature AND parse the thin EventNotification in one step.
    // (Older SDKs named this parseThinEvent; in the current SDK it is
    // parseEventNotification.) Throws on a bad signature.
    let notification;
    try {
      notification = stripe.parseEventNotification(req.body, signature, webhookSecret);
    } catch (e) {
      return res
        .status(400)
        .json({ error: 'Webhook signature verification failed: ' + e.message });
    }

    // Thin events carry no object snapshot — fetch the full event, per spec.
    const event = await stripe.v2.core.events.retrieve(notification.id);

    // Which breeder account is this about?
    const accountId = notification.related_object ? notification.related_object.id : null;

    let handled = null;
    if (event.type === 'v2.core.account[requirements].updated') {
      handled = await handleRequirementsUpdated(stripe, accountId);
    } else if (
      event.type === 'v2.core.account[.recipient].capability_status_updated'
    ) {
      handled = await handleCapabilityStatusUpdated(stripe, accountId);
    } else {
      console.log('[webhook] ignoring event type:', event.type);
    }

    // Always answer 200 quickly so Stripe doesn't retry the delivery.
    res.json({ received: true, type: event.type, accountId, handled });
  })
);

// Handler: v2.core.account[requirements].updated
// Fired when what Stripe needs from the breeder changes (new regulation, …).
async function handleRequirementsUpdated(stripe, accountId) {
  if (!accountId) return 'no related account on event';
  // Re-read the account FRESH from the API — never trust cached state here.
  const account = await stripe.v2.core.accounts.retrieve(accountId, {
    include: ['configuration.recipient', 'requirements'],
  });
  const summary = accountStatusSummary(account);
  console.log(
    '[webhook] requirements updated for ' + accountId + ': ' + JSON.stringify(summary)
  );
  // PRODUCTION TODO: email the breeder / surface "action required" in your DB.
  // This sample just logs the fresh status and returns it.
  return summary;
}

// Handler: v2.core.account[.recipient].capability_status_updated
// Fired when a capability on the recipient configuration changes state —
// e.g. stripe_transfers flips to `active`, meaning the breeder can now be paid.
async function handleCapabilityStatusUpdated(stripe, accountId) {
  if (!accountId) return 'no related account on event';
  const account = await stripe.v2.core.accounts.retrieve(accountId, {
    include: ['configuration.recipient', 'requirements'],
  });
  const summary = accountStatusSummary(account);
  console.log(
    '[webhook] capability status updated for ' + accountId + ': ' + JSON.stringify(summary)
  );
  // PRODUCTION TODO: if summary.readyToReceivePayments just became true,
  // mark the breeder "ready" in your DB / notify them.
  return summary;
}

// ---------------------------------------------------------------------------
// 12. Error handling & startup
// ---------------------------------------------------------------------------

// JSON 404 for unknown API routes (pages use the HTML shell instead).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Unknown API route: ' + req.method + ' ' + req.path });
});

// Central error handler: turns thrown errors (including our helpful
// MISSING_* errors) into clean JSON responses instead of stack traces.
app.use((err, req, res, next) => {
  console.error('[error]', err.code || '', err.message);
  const status = err.status || 500;
  const body = { error: err.message || 'Internal server error' };
  if (err.code === 'MISSING_STRIPE_KEY') {
    body.hint = 'Set STRIPE_SECRET_KEY in your .env file (copy .env.example).';
  } else if (err.code === 'MISSING_WEBHOOK_SECRET') {
    body.hint =
      'Run the stripe listen command from the README and set STRIPE_WEBHOOK_SECRET.';
  } else if (err.type === 'StripeInvalidRequestError') {
    body.hint = 'This came back from the Stripe API — check the parameters.';
  }
  res.status(status).json(body);
});

app.listen(PORT, () => {
  console.log(`🐶 Dog Marketplace Connect sample listening on ${APP_URL}`);
  if (!hasStripeKey()) {
    console.log(
      '⚠️  STRIPE_SECRET_KEY is not set — pages will render, but every ' +
        'Stripe call fails fast with a helpful error. See .env.example.'
    );
  } else {
    console.log('✅ STRIPE_SECRET_KEY is configured.');
  }
});
