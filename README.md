# Spawn Internet — Coin Internet Vendo System

Production-ready Piso WiFi / coin-vendo platform: captive portal, coin→time
billing, cloud management, and role-based dashboards. Built with **Node.js +
Express** on the server, **vanilla JS + Bootstrap-grade custom CSS** on the
client, and **Supabase (PostgreSQL + Auth + Realtime + RLS)** as the cloud
backend.

---

## 1. Architecture at a glance

```
                       ┌──────────────────────────────────────────┐
  Customer phone  ──── │  Captive Portal  (public/index.html)       │
  (after WiFi join)    │  • live remaining time  • voucher redeem   │
                       └───────────────┬────────────────────────────┘
                                       │  REST (fetch)
  Vendo NodeMCU  ─── x-device-key ───► │
  (coin pulse / heartbeat)             ▼
                       ┌──────────────────────────────────────────┐
                       │  Express API  (server.js + routes)         │
                       │  • JWT staff auth   • device-key auth      │
                       │  • RBAC middleware  • rate limiting        │
                       │  • service_role Supabase client (bypass    │
                       │    RLS; RBAC enforced in app layer)        │
                       └───────────────┬────────────────────────────┘
                                       │  supabase-js / RPC
                                       ▼
                       ┌──────────────────────────────────────────┐
                       │  Supabase PostgreSQL                       │
                       │  • tables + ENUMs   • RLS policies         │
                       │  • add_credits(), redeem_voucher(),        │
                       │    expire_sessions()  • triggers           │
                       └────────────────────────────────────────────┘

  Staff browsers ── JWT ──► Admin / Technician / Operator dashboards
```

**Why this split?** The server holds the `service_role` key and is the only
thing that writes privileged data, with RBAC enforced in middleware. RLS is the
second line of defense for any client (e.g. Realtime subscriptions) that uses
the anon key directly.

---

## 2. Folder structure

```
spawn-vendo/
├── server.js                  # Express entry: security, static, API, sweep
├── package.json
├── .env.example               # copy to .env and fill in
├── config/
│   └── supabase.js            # admin (service_role) + anon clients
├── middleware/
│   ├── auth.js                # signToken, authenticate, authorize, deviceAuth
│   └── error.js               # notFound + central errorHandler
├── routes/
│   └── index.js               # every REST route, mounted at /api
├── controllers/
│   ├── auth.controller.js     # login / register / me
│   ├── coin.controller.js     # coin insert, session status, history
│   ├── voucher.controller.js  # generate / list / redeem / void
│   ├── device.controller.js   # devices CRUD + heartbeat + maintenance
│   └── admin.controller.js    # stats, revenue, settings, users, collections, audit
├── services/
│   └── audit.service.js       # fire-and-forget audit logging
├── utils/
│   └── helpers.js             # asyncHandler, ok/fail, voucher codes
├── db/
│   ├── schema.sql             # tables, ENUMs, functions, triggers, seed row
│   ├── rls.sql                # Row Level Security policies
│   └── seed.js                # create first admin account
├── examples/
│   └── nodemcu_coin_post.ino  # firmware → API reference
└── public/
    ├── index.html             # CUSTOMER captive portal
    ├── login.html             # staff login
    ├── css/app.css            # shared theme (rainbow-on-black)
    ├── js/
    │   ├── api.js             # fetch helper, auth guard, formatters
    │   └── admin.js           # admin dashboard logic
    ├── admin/index.html       # ADMIN dashboard
    ├── technician/index.html  # TECHNICIAN dashboard
    └── operator/index.html    # OPERATOR dashboard
```

---

## 3. Database tables

| Table | Purpose |
|---|---|
| `profiles` | staff (admin / technician / operator), 1:1 with `auth.users` |
| `vendo_devices` | each coin machine (MAC, VLAN, area, status, operator) |
| `settings` | pricing: `peso_rate` + `minutes_rate` (versioned, one active) |
| `coin_transactions` | every coin insert (deduped on `txn_ref`) |
| `internet_sessions` | per-client-MAC session with `remaining_seconds`, `end_time` |
| `vouchers` | prepaid time codes (`unused` / `used` / `void`) |
| `collections` | operator cash collections per device/date |
| `maintenance_requests` | technician troubleshooting records |
| `audit_logs` | privileged-action trail |

**Key Postgres functions** (called from the API via RPC):
- `add_credits(device, mac, amount, txn_ref)` — atomic: logs the coin txn,
  computes minutes from the active rate, and tops up / creates the session.
  Deduplicates on `txn_ref` so firmware retries are safe.
- `redeem_voucher(code, mac, device)` — locks the voucher row, marks it used,
  adds its minutes to the session.
- `expire_sessions()` — flips active sessions whose `end_time` has passed to
  `expired`. The server calls it every 60 s; you can also schedule it with
  `pg_cron`.

---

## 4. Setup

### 4.1 Create the Supabase project
1. Create a project at supabase.com. Note the **Project URL**, **anon key**,
   and **service_role key** (Project Settings → API).
2. Open the **SQL Editor** and run, in order:
   - `db/schema.sql`
   - `db/rls.sql`

### 4.2 Configure the server
```bash
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY,
# a long random JWT_SECRET, and a DEVICE_API_KEY for your firmware.
npm install
```

### 4.3 Create the first admin
```bash
node db/seed.js admin@spawn.net "ChangeMe123!" "Wendell Dampios"
```

### 4.4 Run
```bash
npm run dev      # nodemon (development)
npm start        # production
```
Open:
- `http://localhost:3000/` — customer captive portal
- `http://localhost:3000/login.html` — staff login → role-based redirect

---

## 5. REST API reference

Auth: staff routes need `Authorization: Bearer <token>`; device routes need
`x-device-key: <DEVICE_API_KEY>`. Public routes need neither.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET  | `/api/health` | – | liveness |
| GET  | `/api/config` | – | supabase url + anon key for the browser |
| POST | `/api/auth/login` | – | `{email,password}` → `{token, profile}` |
| POST | `/api/auth/register` | admin | create staff user |
| GET  | `/api/auth/me` | staff | current profile |
| POST | `/api/coin/insert` | device | `{device_id,client_mac,amount,txn_ref}` |
| GET  | `/api/coin/session/:mac` | – | live remaining seconds |
| GET  | `/api/coin/history/:mac` | – | recent sessions + coins |
| POST | `/api/vouchers/redeem` | – | `{code,client_mac,device_id}` |
| POST | `/api/vouchers/generate` | admin | `{minutes,count}` |
| GET  | `/api/vouchers` | admin | list |
| POST | `/api/vouchers/void` | admin | `{id}` |
| GET  | `/api/devices` | staff | scoped by role |
| POST | `/api/devices` | admin | create |
| PATCH| `/api/devices/:id` | admin/tech | tech may change status only |
| DELETE| `/api/devices/:id` | admin | delete |
| POST | `/api/devices/heartbeat` | device | `{mac_address}` |
| GET/POST/PATCH | `/api/maintenance[/:id]` | admin/tech | maintenance flow |
| GET  | `/api/admin/stats` | staff | headline numbers |
| GET  | `/api/admin/revenue?range=` | admin | chart series |
| GET  | `/api/admin/transactions` | admin | recent txns |
| GET/PUT | `/api/admin/settings` | admin | pricing |
| GET  | `/api/admin/users` | admin | staff list |
| PATCH| `/api/admin/users/:id/active` | admin | enable/disable |
| GET  | `/api/admin/audit` | admin | audit log |
| GET/POST | `/api/collections` | admin/operator | collections |

All responses use `{ success: boolean, data?|error }`.

---

## 6. Captive portal & firmware wiring

1. On your MikroTik/router captive portal, redirect joined clients to the
   portal with their MAC and the device id, e.g.
   `https://your-app/?mac=$(mac)&device=<vendo_devices.id>`.
2. The portal polls `GET /api/coin/session/:mac` every 5 s and shows the live
   countdown. When time hits zero it flips to expired automatically.
3. The vendo's NodeMCU posts each coin to `POST /api/coin/insert` with the
   client's MAC and a unique `txn_ref` (see `examples/nodemcu_coin_post.ino`),
   and sends `POST /api/devices/heartbeat` every ~2 min so the dashboard shows
   online/offline correctly.

---

## 7. Deployment (Railway / Render / VPS)

**Railway** (matches your existing setup):
1. Push this repo to GitHub.
2. New Railway project → Deploy from repo. Railway auto-detects Node.
3. Set the env vars from `.env.example` in the Railway dashboard.
4. Start command: `npm start`. Railway provides `PORT` automatically.
5. Map your domain; update `API_BASE` in the firmware to the Railway URL.

**Optional cron for expiry** — instead of the in-process sweep, schedule in
Supabase: `select cron.schedule('expire','* * * * *',$$select expire_sessions()$$);`
(requires the `pg_cron` extension).

---

## 8. Security checklist

- `service_role` key lives **only** on the server (never shipped to browser).
- Staff auth uses Supabase Auth → our own short-lived JWT; RBAC in middleware.
- Device endpoints gated by a shared `x-device-key`; rate-limited.
- Login + coin endpoints rate-limited (`express-rate-limit`).
- `helmet` security headers; CORS configurable.
- RLS enabled on every table as defense-in-depth.
- Coin inserts are idempotent via `txn_ref` to prevent double-credit on retry.
- Audit log records privileged actions.

> Rotate `JWT_SECRET` and `DEVICE_API_KEY` before going live, and enable HTTPS
> (Railway/Render terminate TLS for you).
