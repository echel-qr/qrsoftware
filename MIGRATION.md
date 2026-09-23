# Moving Echel to another host

Echel is an ordinary **Node + PostgreSQL** application. It runs on anything that
offers both — a Hostinger VPS, another cloud, or a machine in your own office.
Nothing in the code is tied to Render or to Supabase.

Everything you need is in **Superadmin → 🗄️ Database**:

| | |
|---|---|
| 🚚 Move to another host | what this server runs on, and what the new one still needs |
| 💾 Download backup | every row of every table, in one file |
| ♻️ Restore into this database | that file, written into the new server's database |

## What travels, and what does not

| | |
|---|---|
| Shops, orders, payments, partners, translations, settings | the backup file |
| Uploaded documents, logos, brand images | stay in Cloudinary — set the same keys on the new host and they serve straight away |
| The desktop agent on every shop's computer | nothing to do, as long as the domain stays the same |
| The QR code stuck up in every shop | contains the domain, so **keep the domain** and only move where it points |

Keeping the domain is what makes the move invisible. If the domain ever has to
change, every shop needs a new QR poster — plan for that separately.

## Before you start

1. Open **Superadmin → 🗄️ Database → 🚚 Move to another host** and read the check.
2. Press **💾 Download backup**. Keep the file somewhere safe.
3. Write down every setting the check marks **copy as-is**. Read them from the
   old host's own dashboard — they are never shown in this panel, and they must
   never be pasted into a chat or an email.
4. Lower the domain's DNS TTL to 300 seconds a day before the move, so the
   switch takes minutes instead of hours.

## Moving to a Hostinger VPS

A VPS with 2 GB of memory is enough for a few hundred shops.

### 1. Prepare the machine

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install nginx postgresql git curl ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs
sudo npm i -g pm2
```

### 2. Create the database

```bash
sudo -u postgres psql -c "CREATE USER echel WITH PASSWORD 'choose-a-long-one';"
sudo -u postgres psql -c "CREATE DATABASE echel OWNER echel;"
```

### 3. Put the code on it

```bash
git clone https://github.com/echel-qr/qrsoftware.git /var/www/echel
cd /var/www/echel && npm ci --omit=dev
```

### 4. Write the settings

Create `/var/www/echel/.env`. The check in Superadmin lists every name and says
which ones to copy from the old host without changing them.

```
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://echel:choose-a-long-one@localhost:5432/echel
BASE_URL=https://echel.in
JWT_SECRET=<copy from the old host>
SUPER_ADMIN_ID=<copy from the old host>
SUPER_ADMIN_PASSWORD=<copy from the old host>
CLOUDINARY_CLOUD_NAME=<copy from the old host>
CLOUDINARY_API_KEY=<copy from the old host>
CLOUDINARY_API_SECRET=<copy from the old host>
```

`JWT_SECRET` is the one people forget. A different secret signs everybody out —
shops, agents and the super admin all have to log in again.

### 5. Start it

```bash
pm2 start server.js --name echel
pm2 save && pm2 startup
```

The server creates its own tables on first start. Check them:

```bash
curl -s localhost:3000/healthz
```

### 6. Nginx and a certificate

```nginx
server {
  server_name echel.in www.echel.in;
  client_max_body_size 50M;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

```bash
sudo certbot --nginx -d echel.in -d www.echel.in
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

`X-Forwarded-For` matters: without it every visitor looks like one IP address
and the abuse limits misfire.

### 7. Restore the data

Open `https://<the VPS IP or a temporary name>/superadmin`, sign in, go to
**🗄️ Database → Restore a backup into this database**, choose the file, press
**🔎 Check the file**, read what it says, type `RESTORE` and press the button.

Either every row is written or none is — the whole restore is one transaction,
so a failure leaves the database exactly as it was.

### 8. Switch the domain over

Point the domain's A record at the VPS. Watch both hosts for an hour: requests
arriving at the old one mean DNS has not finished moving. When the new host has
been serving alone for a day, take the old one down.

**Take a fresh backup immediately before the switch.** Anything a shop does on
the old host after your backup would otherwise be left behind.

## Cloudflare

Cloudflare is worth using, but be clear about what it does here.

**It can:**

- hold the domain and its DNS, and sit in front of the server (the orange
  cloud): free TLS, a worldwide cache for images and scripts, and protection
  from floods;
- reach a VPS that has no public IP address, through a Cloudflare Tunnel;
- store uploaded documents in R2 instead of Cloudinary — that is a code change,
  not a migration step, and it is not needed for a move.

**It cannot** run this server. Cloudflare Workers and Pages execute short
request handlers, not a long-running Node process with PDF work and a direct
PostgreSQL connection. Anyone who says "move it to Cloudflare" means Cloudflare
in front of a real server. So: host on the VPS, and put Cloudflare in front.

To put Cloudflare in front:

1. Add the domain in Cloudflare and change the nameservers at the registrar.
2. Create an A record for the VPS and switch the cloud to orange.
3. SSL/TLS mode **Full (strict)** — the VPS already has a real certificate.
4. Leave `/api/*` uncached. The rest of the site may be cached.
5. Set `client_max_body_size` in Nginx to at least the upload limit; Cloudflare
   has an upload limit of its own on the free plan (100 MB), which is well above
   what a print job needs.

## Checking that nothing was lost

After the restore, compare the two:

- **Superadmin → 🗄️ Database** shows a row count per table on both hosts. They
  should match.
- Open a shop's dashboard and check its orders, its prices and its QR code.
- Print one test page through a shop whose agent is running.
- Open a White Label partner's link and confirm their branding appears.

## If something goes wrong

The old host is untouched until you switch DNS, so rolling back is just pointing
the domain back at it. Keep it running, paid, for a week after the move.

## Deleting the data

The restore replaces everything in the target database. Nothing in this panel
deletes the old host's data — do that yourself, from the old provider, and only
after the new one has been serving for a while.
