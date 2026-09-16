# Echel client edition

## Preview and verification

- `npm run preview`: read-only design preview at `http://localhost:3100`. It uses local fixtures and cannot save settings, charge payments or operate a printer.
- `npm test`: branding API validation, billing rules, PostgreSQL activation/renewal, fresh schema startup, authenticated backend smoke test, edition restrictions, language switching, desktop interactions and upload/mail compatibility (24 checks).
- `npm run check`: server and inline JavaScript syntax checks.
- Install development dependencies to run the tests; PostgreSQL tests use PGlite in memory and never access a live database.

## Configuration

Superadmin → **Brand & Website** manages identity, contact details, social links, business hours, setup video, homepage statistics and review badges. Blank optional contact fields are hidden publicly. Supplied Echel contacts are the defaults for new installations.

Superadmin → **Plan Features** manages separate English and Manipuri feature lists for Demo, Starter, Pro and Premium.

Superadmin → **Setup Fee** sets each paid tier's price and billing cycle: Monthly, Quarterly, Yearly or Lifetime. The selected term is captured at registration. Existing subscriptions retain their term and renewal price. Renewals are manual payments; this change does not create automatic debit mandates. Feature tiers remain separate from billing duration.

The old database-copy action and Cloudinary size-based deletion action are disabled. No existing production database records or cloud assets were deleted. White-label routes and programs are unavailable in this edition.

## Language status

The website offers English and Manipuri (Meitei Mayek). Language switching now includes dynamically changed placeholders/accessibility labels and native alert, confirm and prompt messages. User-entered values are preserved. Manipuri dictionary coverage remains incomplete; `test/ui-catalog.json` inventories the outstanding interface text. The external translation batch is awaiting explicit approval because it includes private administration interface text. No customer records or credentials are included in that catalogue.

The Windows Agent Panel is English-only, as requested in the latest instruction. It has Echel branding, a new navigation rail, connection card and printer controls. The Python bridge and printer-save safeguards remain intact. `test/desktop.test.js` verifies printer save, paid-shop connection and navigation with a local mock bridge.

## Render and Supabase deployment preparation

- `render.yaml` defines a free Node web service, Singapore region, `npm ci --omit=dev`, and `/healthz` database readiness checks. It passed validation against Render's official JSON schema. It still needs to be created in the user's Render account.
- Use a **new Echel Supabase project** and its session pooler connection string. The original QR Se Print Git remote and live database must not be reused. Application tables have RLS enabled and access revoked from Supabase's browser roles; database access stays behind the existing Express authentication.
- Initialization failures stop startup. The old database-copy implementation has been removed. A real PostgreSQL engine test covers fresh schema creation, Echel defaults, access restrictions and repeat startup.
- TLS verifies database certificates. Supply Supabase's CA certificate through `DATABASE_SSL_CA` if the pooler requires it; do not disable verification.
- `BASE_URL` and `SITE_URL` default to `RENDER_EXTERNAL_URL`. Set them to the custom domain after it is connected.
- Cloudinary uploads and cleanup use `echel/jobs/`; logos use `echel/branding/` and are excluded from print cleanup. Cleanup rejects assets outside the Echel job namespace.
- The desktop agent accepts an HTTPS origin from `ECHEL_SERVER_URL` or an adjacent `echel-server.json` containing `{"serverUrl":"https://your-service.onrender.com"}`. This lets the same executable target the initial Render deployment. The downloadable source package includes that configuration automatically.
- `OWNER_RAZORPAY_KEY_ID` and `OWNER_RAZORPAY_KEY_SECRET` are needed to collect plan payments. Shop printing payments continue to use each shop's own gateway credentials. SMTP/Brevo is configured in Superadmin.
- A dependency lockfile is included. Multer, Nodemailer and UUID were updated; local tests cover multipart upload/size limits, mail rendering (without delivery), and ID generation.

After reconnection, GitHub, Render and Supabase were reported installed/enabled, but their account tools remained unavailable in this task. Cloudinary was absent from the plugin search. The browser check was rejected by automatic approval review because of the account usage limit. No cloud resources were created or changed, and no deployment has been reported as live.

## Remaining release checks

The read-only preview cannot verify a real shop registration, payment gateway callback, authenticated settings save against the deployment database or physical printing. Check those in an isolated staging deployment before release. The Windows executable's printing engine and panel assets were verified inside its archive; installation and printing on the client's actual hardware still require a smoke test.

Client executable: `../build/echel-client/dist/Echel Agent V2.9.exe` (build 39). The native first-run Shop ID screen, paid-shop prompts, existing-computer warning, demo reminders, print approval, duplex instructions, reconnect notifications and uninstall hint now use English. `python test/native-agent-ui.py` exercises the real prompt functions and generated Windows dialog script without opening the UI or contacting a server. The executable defaults to `https://echel.in` until the deployment origin is supplied through its configuration. Native visual inspection and physical printing remain unverified.
