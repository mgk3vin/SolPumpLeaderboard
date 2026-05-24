# LordpommesX2 SolPump Leaderboard

Leaderboard Website fuer den Kick Streamer LordpommesX2.

## Starten

```bash
npm run dev
```

Danach ist die Seite unter `http://localhost:3000` erreichbar.

## SolPump anbinden

Lege eine `.env` Datei an:

```env
PORT=3000
PUBLIC_BASE_URL=http://localhost:3000
SUPABASE_URL=https://dein-projekt.supabase.co
SUPABASE_ANON_KEY=dein-anon-key
ADMIN_EMAILS=deine-admin-mail@example.com
SOLPUMP_API_URL=https://deine-solpump-api-url
SOLPUMP_COOKIE=dein-cookie
```

Ohne diese Werte zeigt die Website Demo-Daten. Der Cookie wird nur im Node-Server genutzt und nicht an den Browser ausgeliefert.

Der Server normalisiert typische Affiliate-Felder wie `wagered`, `wager`, `totalWagered`, `deposits`, `bets` und `profit`. Sobald die echte SolPump Response-Struktur bekannt ist, kann die Funktion `normalizeSolPumpPayload` in `server.js` exakt auf das Format angepasst werden.

## Supabase Admin-System

1. Neues Supabase Projekt erstellen.
2. In Supabase den SQL Editor oeffnen.
3. Den Inhalt aus `supabase.sql` ausfuehren.
4. Danach die Admin-Mail eintragen:

```sql
insert into public.admin_users (email)
values ('deine-admin-mail@example.com')
on conflict (email) do nothing;
```

5. In `.env` `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ADMIN_EMAILS` und beim Hosting `PUBLIC_BASE_URL` setzen.
6. In Supabase unter `Authentication > Users` einen User fuer die Admin-Mail anlegen.
7. Admin-Seite oeffnen: `http://localhost:3000/admin.html`

Die oeffentliche Seite liest nur aus Supabase. Schreiben darf nur ein eingeloggter Admin, dessen E-Mail in Supabase Auth, in `admin_users` und in `ADMIN_EMAILS` eingetragen ist.

## Falls Cloudflare den Server blockt

SolPump schuetzt die API teilweise mit einer Browser-Challenge. Dann kann ein lokaler Node-Server die API trotz Cookie nicht direkt abrufen.

Workaround:

1. Starte die Leaderboard-Seite lokal.
2. Oeffne `http://localhost:3000/admin.html`.
3. Logge dich mit der Admin-Mail ein.
4. Ziehe den Button `Leaderboard aktualisieren` in deine Lesezeichenleiste.
5. Oeffne `https://solpump.io/affiliates`.
6. Klicke das Lesezeichen.

Der Import laeuft dann im eingeloggten SolPump-Browser und speichert die normalisierten Daten in Supabase.
