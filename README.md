# LordpommesX2 SolPump Leaderboard

Leaderboard website for the Kick streamer LordpommesX2.

## Start

```bash
npm run dev
```

The site is available at `http://localhost:3000`.

## Connect SolPump

Create a `.env` file:

```env
PORT=3000
PUBLIC_BASE_URL=http://localhost:3000
SUPABASE_URL=https://dein-projekt.supabase.co
SUPABASE_ANON_KEY=dein-anon-key
ADMIN_EMAILS=deine-admin-mail@example.com
SOLPUMP_API_URL=https://your-solpump-api-url
SOLPUMP_COOKIE=your-cookie
```

Without these values, the website shows demo data. The cookie is only used by the Node server and is never sent to the browser.

The server normalizes common affiliate fields like `wagered`, `wager`, `totalWagered`, `commissionGenerated`, `firstSeen`, and `lastSeen`. Large raw token-unit values are converted to SOL.

## Supabase Admin-System

1. Create a new Supabase project.
2. Open the Supabase SQL editor.
3. Run the contents of `supabase.sql`.
4. Add the admin email:

```sql
insert into public.admin_users (email)
values ('your-admin-email@example.com')
on conflict (email) do nothing;
```

5. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ADMIN_EMAILS`, and `PUBLIC_BASE_URL` in `.env` or your hosting provider.
6. In Supabase, create a user for the admin email under `Authentication > Users`.
7. Open the admin page: `http://localhost:3000/admin.html`

The public page only reads from Supabase. Writes are only allowed for signed-in admins whose email exists in Supabase Auth, `admin_users`, and `ADMIN_EMAILS`.

## If Cloudflare Blocks the Server

SolPump can protect the API with a browser challenge. In that case, the Node server cannot fetch the API directly, even with cookies.

Workaround:

1. Start the leaderboard website.
2. Open `http://localhost:3000/admin.html`.
3. Sign in with the admin email and password.
4. Drag the `Update Leaderboard` button into your bookmarks bar.
5. Open `https://solpump.io/affiliates`.
6. Click the bookmark.

The import runs inside the signed-in SolPump browser and saves normalized data to Supabase.
