import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);
let browserIngest = null;
const prizeSplit = [50, 25, 12.5, 6.25, 3.75, 1.25, 0.625, 0.625, 0, 0];
const rateMap = new Map();

await loadEnv();
const solPumpHeaderFile = path.join(__dirname, ".solpump-headers.json");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (url.pathname.startsWith("/api/") && isRateLimited(request, url.pathname === "/api/leaderboard" ? 120 : 40)) {
      sendJson(response, 429, {
        ok: false,
        error: "Too many requests"
      }, request);
      return;
    }

    if (request.method === "OPTIONS") {
      sendCors(request, response, 204);
      return;
    }

    if (url.pathname === "/api/leaderboard") {
      await sendLeaderboard(response);
      return;
    }

    if (url.pathname === "/api/ingest" && request.method === "POST") {
      await receiveBrowserIngest(request, response);
      return;
    }

    if (url.pathname === "/api/start-week" && request.method === "POST") {
      await receiveWeekStart(request, response);
      return;
    }

    if (url.pathname === "/api/bookmarklet") {
      await sendBookmarklet(request, response, url);
      return;
    }

    if (url.pathname === "/api/config") {
      sendConfig(response);
      return;
    }

    if (url.pathname === "/api/admin-status") {
      await sendAdminStatus(request, response);
      return;
    }

    if (url.pathname === "/api/admin/entries") {
      await handleAdminEntries(request, response);
      return;
    }

    await sendStatic(url.pathname, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, {
      ok: false,
      error: "Internal server error"
    }, request);
  }
});

server.listen(port, () => {
  console.log(`LordpommesX2 Leaderboard is running on http://localhost:${port}`);
});

async function sendLeaderboard(response) {
  if (hasSupabaseConfig()) {
    const supabaseResult = await readSupabaseLeaderboard();

    if (supabaseResult.ok) {
      sendJson(response, 200, {
        ok: true,
        source: "supabase",
        updatedAt: supabaseResult.updatedAt,
        week: supabaseResult.week,
        prizeSplit,
        leaderboard: preparePublicLeaderboard(supabaseResult.leaderboard, supabaseResult.week)
      });
      return;
    }

    console.warn(`Supabase konnte nicht gelesen werden: ${supabaseResult.error}`);
  }

  const endpoint = process.env.SOLPUMP_API_URL;
  const cookie = process.env.SOLPUMP_COOKIE;

  if (browserIngest) {
    sendJson(response, 200, {
      ok: true,
      source: "browser",
      updatedAt: browserIngest.updatedAt,
      week: defaultWeek(),
      prizeSplit,
      leaderboard: preparePublicLeaderboard(browserIngest.leaderboard, defaultWeek())
    });
    return;
  }

  if (!endpoint || !cookie) {
    sendJson(response, 200, {
      ok: true,
      source: "demo",
      updatedAt: new Date().toISOString(),
      week: defaultWeek(),
      prizeSplit,
      leaderboard: preparePublicLeaderboard(demoLeaderboard, defaultWeek())
    });
    return;
  }

  const upstreamResponse = await fetch(endpoint, {
    headers: buildSolPumpHeaders(endpoint, cookie)
  });

  if (!upstreamResponse.ok) {
    sendJson(response, upstreamResponse.status, {
      ok: false,
      error: `SolPump API responded with status ${upstreamResponse.status}`
    });
    return;
  }

  const payload = await upstreamResponse.json();
  const leaderboard = normalizeSolPumpPayload(payload);

  sendJson(response, 200, {
    ok: true,
    source: "solpump",
    updatedAt: new Date().toISOString(),
    week: defaultWeek(),
    prizeSplit,
    leaderboard: preparePublicLeaderboard(leaderboard, defaultWeek())
  });
}

async function receiveBrowserIngest(request, response) {
  const body = await readRequestBody(request);
  const requestBody = JSON.parse(body);
  const payload = requestBody.payload || requestBody;
  const leaderboard = normalizeSolPumpPayload(payload);
  const adminAuth = await resolveImportAuth(request);
  const hasAdminCredential = Boolean(request.headers.authorization);

  if (hasSupabaseConfig() && hasAdminCredential && !adminAuth.ok) {
    sendJson(response, adminAuth.status || 401, {
      ok: false,
      error: adminAuth.error || "Admin login required"
    }, request);
    return;
  }

  if (hasSupabaseConfig() && adminAuth.ok) {
    const saved = await saveSupabaseLeaderboard(
      leaderboard,
      adminAuth.authHeader,
      {
        mode: "refresh"
      },
      adminAuth
    );

    if (!saved.ok) {
      sendJson(response, saved.status || 500, {
        ok: false,
        error: saved.error || "Supabase import failed"
      }, request);
      return;
    }

    sendJson(response, 200, {
      ok: true,
      source: "supabase",
      rows: leaderboard.length
    }, request);
    return;
  }

  browserIngest = {
    updatedAt: new Date().toISOString(),
    leaderboard
  };

  sendJson(response, 200, {
    ok: true,
    rows: leaderboard.length
  }, request);
}

async function receiveWeekStart(request, response) {
  const body = await readRequestBody(request);
  const requestBody = JSON.parse(body);
  const leaderboard = normalizeSolPumpPayload(requestBody.payload || requestBody);
  const pot = numberFrom(requestBody.pot);
  const adminAuth = await resolveImportAuth(request);

  if (!hasSupabaseConfig() || !adminAuth.ok) {
    sendJson(response, adminAuth.status || 401, {
      ok: false,
      error: adminAuth.error || "Admin login required"
    }, request);
    return;
  }

  if (!Number.isFinite(pot) || pot <= 0) {
    sendJson(response, 400, {
      ok: false,
      error: "Prize pot must be greater than 0 SOL"
    }, request);
    return;
  }

  const saved = await saveSupabaseLeaderboard(
    leaderboard,
    adminAuth.authHeader,
    {
      mode: "start",
      pot
    },
    adminAuth
  );

  if (!saved.ok) {
    sendJson(response, saved.status || 500, {
      ok: false,
      error: saved.error || "Could not start the week"
    }, request);
    return;
  }

  sendJson(response, 200, {
    ok: true,
    rows: leaderboard.length,
    pot
  }, request);
}

async function sendBookmarklet(request, response, requestUrl) {
  const solPumpPath = new URL(process.env.SOLPUMP_API_URL || "https://solpump.io/api/v1/affiliate?sort=Most+Wagered").pathname;
  const solPumpQuery = new URL(process.env.SOLPUMP_API_URL || "https://solpump.io/api/v1/affiliate?sort=Most+Wagered").search;
  const apiPath = `${solPumpPath}${solPumpQuery}`;
  const action = requestUrl.searchParams.get("action") === "start" ? "start" : "refresh";
  const targetPath = action === "start" ? "/api/start-week" : "/api/ingest";
  const ingestUrl = process.env.PUBLIC_BASE_URL ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}${targetPath}` : `http://localhost:${port}${targetPath}`;
  const authHeader = request.headers.authorization || "";
  const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  const admin = await requireAdmin(authHeader);

  if (!admin.ok) {
    sendJson(response, admin.status || 401, {
      ok: false,
      error: admin.error || "Admin login required"
    });
    return;
  }

  const authHeaderExpression = `{"content-type":"application/json","authorization":"Bearer "+${JSON.stringify(sessionToken)}}`;
  const potScript = action === "start" ? `const pot=Number(prompt("Prize pot in SOL","10"));if(!Number.isFinite(pot)||pot<=0){alert("Please enter a valid SOL pot.");return;}` : `const pot=null;`;
  const bodyExpression = action === "start" ? `{payload:j,pot}` : `{payload:j}`;
  const successText = action === "start" ? `"New leaderboard week started: "+o.rows+" affiliates, "+o.pot+" SOL pot"` : `"Leaderboard refreshed: "+o.rows+" affiliates"`;
  const script = `(async()=>{if(location.hostname!=="solpump.io"){alert("Open SolPump Affiliates first, then click this bookmark again.");location.href="https://solpump.io/affiliates";return;}${potScript}const r=await fetch(${JSON.stringify(apiPath)},{credentials:"include"});const j=await r.json();const p=await fetch(${JSON.stringify(ingestUrl)},{method:"POST",headers:${authHeaderExpression},body:JSON.stringify(${bodyExpression})});const text=await p.text();let o;try{o=JSON.parse(text)}catch{throw new Error("Import endpoint did not return JSON. Check PUBLIC_BASE_URL and redeploy: "+${JSON.stringify(ingestUrl)}+" returned "+text.slice(0,80))}if(!p.ok||!o.ok)throw new Error(o.error||"Import failed");alert(${successText});})().catch(e=>alert("Leaderboard import failed: "+e.message));`;

  sendJson(response, 200, {
    ok: true,
    mode: "session-token",
    bookmarklet: `javascript:${encodeURIComponent(script)}`
  });
}

function sendConfig(response) {
  sendJson(response, 200, {
    ok: true,
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ""
  });
}

async function sendAdminStatus(request, response) {
  const authHeader = request.headers.authorization || "";

  if (!hasSupabaseConfig() || !authHeader.startsWith("Bearer ")) {
    sendJson(response, 401, {
      ok: false,
      isAdmin: false
    });
    return;
  }

  const user = await readSupabaseUser(authHeader);
  const isAdmin = user.ok && (await isAdminUser(authHeader, user.email));

  sendJson(response, 200, {
    ok: true,
    isAdmin,
    email: user.email || ""
  });
}

async function handleAdminEntries(request, response) {
  const authHeader = request.headers.authorization || "";
  const admin = await requireAdmin(authHeader);

  if (!admin.ok) {
    sendJson(response, admin.status, {
      ok: false,
      error: admin.error
    });
    return;
  }

  if (request.method === "GET") {
    const result = await listAdminEntries(authHeader);
    sendJson(response, result.status || 200, result);
    return;
  }

  if (request.method === "POST") {
    const body = JSON.parse(await readRequestBody(request));
    const result = await createAdminEntry(authHeader, body);
    sendJson(response, result.status || 200, result);
    return;
  }

  if (request.method === "PATCH") {
    const body = JSON.parse(await readRequestBody(request));
    const result = await updateAdminEntry(authHeader, body);
    sendJson(response, result.status || 200, result);
    return;
  }

  if (request.method === "DELETE") {
    const body = JSON.parse(await readRequestBody(request));
    const result = await deleteAdminEntry(authHeader, body);
    sendJson(response, result.status || 200, result);
    return;
  }

  sendJson(response, 405, {
    ok: false,
    error: "Method not allowed"
  });
}

async function requireAdmin(authHeader) {
  if (!hasSupabaseConfig() || !authHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      error: "Admin login required"
    };
  }

  const user = await readSupabaseUser(authHeader);

  if (!user.ok || !(await isAdminUser(authHeader, user.email))) {
    return {
      ok: false,
      status: 403,
      error: "This email is not enabled as an admin"
    };
  }

  return {
    ok: true,
    email: user.email
  };
}

async function resolveImportAuth(request) {
  const authHeader = request.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      status: 401,
      error: "Admin login required"
    };
  }

  const admin = await requireAdmin(authHeader);
  return {
    ...admin,
    trustedImport: false,
    authHeader
  };
}

function buildSolPumpHeaders(endpoint, cookie) {
  const headers = {
    accept: "application/json, text/plain, */*",
    "accept-language": process.env.SOLPUMP_ACCEPT_LANGUAGE || "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
    cookie,
    origin: process.env.SOLPUMP_ORIGIN || new URL(endpoint).origin,
    referer: process.env.SOLPUMP_REFERER || `${new URL(endpoint).origin}/`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent":
      process.env.SOLPUMP_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
  };

  addOptionalHeader(headers, "authorization", process.env.SOLPUMP_AUTHORIZATION);
  addOptionalHeader(headers, "x-csrf-token", process.env.SOLPUMP_X_CSRF_TOKEN);
  addOptionalHeader(headers, "x-xsrf-token", process.env.SOLPUMP_X_XSRF_TOKEN);
  addOptionalHeader(headers, "x-requested-with", process.env.SOLPUMP_X_REQUESTED_WITH);
  Object.assign(headers, loadSolPumpHeaderOverrides());

  return headers;
}

function loadSolPumpHeaderOverrides() {
  if (!existsSync(solPumpHeaderFile)) {
    return {};
  }

  try {
    const content = readFileSync(solPumpHeaderFile, "utf8");
    const headers = JSON.parse(content);

    for (const unsafeHeader of ["connection", "host", "content-length", "if-none-match"]) {
      delete headers[unsafeHeader];
    }

    return headers;
  } catch (error) {
    console.warn(`Konnte ${path.basename(solPumpHeaderFile)} nicht lesen: ${error.message}`);
    return {};
  }
}

function addOptionalHeader(headers, name, value) {
  if (value) {
    headers[name] = value;
  }
}

function preparePublicLeaderboard(leaderboard, week = defaultWeek()) {
  return leaderboard
    .filter((entry) => !entry.blocked)
    .slice(0, 10)
    .map((entry, index) => ({
      rank: index + 1,
      name: censorName(entry.name),
      wagered: entry.wagered,
      prize: calculatePrize(index + 1, week.pot),
      avatar: entry.avatar
    }));
}

function calculatePrize(rank, pot) {
  const percentage = prizeSplit[rank - 1] || 0;
  return Number(((numberFrom(pot) * percentage) / 100).toFixed(4));
}

function defaultWeek() {
  const now = new Date();
  const endsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  return {
    pot: 0,
    startedAt: now.toISOString(),
    endsAt: endsAt.toISOString()
  };
}

function censorName(name) {
  const value = String(name || "Affiliate");

  if (value.length <= 4) {
    return `${value.slice(0, 1)}*****${value.slice(-1)}`;
  }

  return `${value.slice(0, 2)}*****${value.slice(-2)}`;
}

function hasSupabaseConfig() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}

function parseAdminEmails() {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

async function isAdminUser(authHeader, email) {
  const normalizedEmail = String(email || "").toLowerCase();

  if (!normalizedEmail) {
    return false;
  }

  if (parseAdminEmails().includes(normalizedEmail)) {
    return true;
  }

  return readSupabaseAdminUser(authHeader, normalizedEmail);
}

async function readSupabaseAdminUser(authHeader, email) {
  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/admin_users?email=eq.${encodeURIComponent(email)}&select=email&limit=1`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY,
          authorization: authHeader
        }
      }
    );

    if (!response.ok) {
      return false;
    }

    const rows = await response.json();
    return rows.some((row) => String(row.email || "").toLowerCase() === email);
  } catch {
    return false;
  }
}

async function readSupabaseLeaderboard() {
  try {
    let response = await fetchSupabaseLeaderboard(
      "rank,name,wagered,deposits,bets,profit,commission_generated,first_seen,last_seen,blocked,avatar,updated_at"
    );

    if (response.status === 400) {
      response = await fetchSupabaseLeaderboard("rank,name,wagered,deposits,bets,profit,avatar,updated_at");
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `Status ${response.status}`
      };
    }

    const rows = await response.json();
    const week = await readSupabaseWeek();
    const leaderboard = rows.map((row) => ({
      rank: numberFrom(row.rank),
      name: row.name,
      wagered: solAmountFrom(row.wagered),
      deposits: solAmountFrom(row.deposits),
      bets: numberFrom(row.bets),
      profit: solAmountFrom(row.profit),
      commissionGenerated: solAmountFrom(row.commission_generated ?? row.commissionGenerated ?? row.profit),
      firstSeen: row.first_seen ?? row.firstSeen ?? null,
      lastSeen: row.last_seen ?? row.lastSeen ?? null,
      blocked: Boolean(row.blocked),
      avatar: row.avatar
    }));

    return {
      ok: true,
      updatedAt: rows[0]?.updated_at || new Date().toISOString(),
      week,
      leaderboard
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

async function readSupabaseWeek() {
  try {
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leaderboard_settings?id=eq.1&select=pot,started_at,ends_at&limit=1`, {
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`
      }
    });

    if (!response.ok) {
      return defaultWeek();
    }

    const rows = await response.json();
    const row = rows[0];

    if (!row) {
      return defaultWeek();
    }

    return {
      pot: numberFrom(row.pot),
      startedAt: row.started_at,
      endsAt: row.ends_at
    };
  } catch {
    return defaultWeek();
  }
}

function fetchSupabaseLeaderboard(select) {
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/leaderboard_entries?select=${select}&order=wagered.desc`, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`
    }
  });
}

async function listAdminEntries(authHeader) {
  try {
    let response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/leaderboard_entries?select=rank,name,wagered,baseline_wager,current_wager,blocked,avatar,updated_at&order=wagered.desc`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY,
          authorization: authHeader
        }
      }
    );

    if (response.status === 400) {
      response = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/leaderboard_entries?select=rank,name,wagered,avatar,updated_at&order=wagered.desc`,
        {
          headers: {
            apikey: process.env.SUPABASE_ANON_KEY,
            authorization: authHeader
          }
        }
      );
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: "Could not load leaderboard entries"
      };
    }

    const entries = await response.json();

    return {
      ok: true,
      entries: entries.map((entry, index) => ({
        rank: index + 1,
        storedRank: numberFrom(entry.rank),
        name: entry.name,
        wagered: solAmountFrom(entry.wagered),
        baselineWager: solAmountFrom(entry.baseline_wager ?? 0),
        currentWager: solAmountFrom(entry.current_wager ?? entry.wagered),
        blocked: Boolean(entry.blocked),
        avatar: entry.avatar,
        updatedAt: entry.updated_at
      }))
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error.message
    };
  }
}

async function createAdminEntry(authHeader, body) {
  const entriesResult = await listAdminEntries(authHeader);
  if (!entriesResult.ok) return entriesResult;

  const name = String(body.name || "").trim();
  const wagered = numberFrom(body.wagered);

  if (!name) {
    return {
      ok: false,
      status: 400,
      error: "Name is required"
    };
  }

  if (entriesResult.entries.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
    return {
      ok: false,
      status: 409,
      error: "A user with this name already exists"
    };
  }

  const maxRank = entriesResult.entries.reduce((highest, entry) => Math.max(highest, numberFrom(entry.storedRank)), 0);
  const now = new Date().toISOString();
  const writeAuthHeader = supabaseWriteAuthHeader(authHeader);
  const row = {
    rank: maxRank + 1,
    name,
    wagered,
    baseline_wager: 0,
    current_wager: wagered,
    deposits: 0,
    bets: 0,
    profit: 0,
    commission_generated: 0,
    first_seen: null,
    last_seen: null,
    blocked: false,
    avatar: null,
    updated_at: now
  };
  const insertResult = await insertLeaderboardRows(authHeader, row, writeAuthHeader);

  if (!insertResult.ok) {
    return {
      ok: false,
      status: insertResult.status,
      error: `Could not create user${insertResult.error ? `: ${insertResult.error}` : ""}`
    };
  }

  const refreshed = await listAdminEntries(authHeader);
  return {
    ...refreshed,
    createdName: name
  };
}

async function insertLeaderboardRows(readAuthHeader, rows, writeAuthHeader = readAuthHeader) {
  const inserted = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leaderboard_entries`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      authorization: writeAuthHeader,
      "content-type": "application/json",
      prefer: "return=minimal"
    },
    body: JSON.stringify(rows)
  });

  if (inserted.ok) {
    return {
      ok: true
    };
  }

  const details = await readSupabaseError(inserted);
  if (!isMissingBlockedColumn(details)) {
    return {
      ok: false,
      status: inserted.status,
      error: details
    };
  }

  const fallbackRows = stripBlocked(rows);
  const fallback = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leaderboard_entries`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      authorization: writeAuthHeader,
      "content-type": "application/json",
      prefer: "return=minimal"
    },
    body: JSON.stringify(fallbackRows)
  });

  if (!fallback.ok) {
    return {
      ok: false,
      status: fallback.status,
      error: await readSupabaseError(fallback)
    };
  }

  return {
    ok: true
  };
}

async function updateAdminEntry(authHeader, body) {
  const entriesResult = await listAdminEntries(authHeader);
  if (!entriesResult.ok) return entriesResult;

  const name = String(body.name || "").trim();
  const nextName = String(body.nextName || name).trim();
  const wagered = numberFrom(body.wagered);
  const blocked = Boolean(body.blocked);

  if (!name || !nextName) {
    return {
      ok: false,
      status: 400,
      error: "Name is required"
    };
  }

  const currentEntry = entriesResult.entries.find((entry) => entry.name === name);

  if (!currentEntry) {
    return {
      ok: false,
      status: 404,
      error: "User was not found"
    };
  }

  if (
    nextName.toLowerCase() !== name.toLowerCase() &&
    entriesResult.entries.some((entry) => entry.name.toLowerCase() === nextName.toLowerCase())
  ) {
    return {
      ok: false,
      status: 409,
      error: "A user with this name already exists"
    };
  }

  const writeAuthHeader = supabaseWriteAuthHeader(authHeader);
  const updatePayload = {
    name: nextName,
    wagered,
    current_wager: numberFrom(currentEntry.baselineWager) + wagered,
    blocked,
    updated_at: new Date().toISOString()
  };
  const updated = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leaderboard_entries?name=eq.${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      authorization: writeAuthHeader,
      "content-type": "application/json",
      prefer: "return=minimal"
    },
    body: JSON.stringify(updatePayload)
  });

  if (!updated.ok) {
    const details = await readSupabaseError(updated);
    if (isMissingBlockedColumn(details)) {
      const fallback = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leaderboard_entries?name=eq.${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY,
          authorization: writeAuthHeader,
          "content-type": "application/json",
          prefer: "return=minimal"
        },
        body: JSON.stringify(stripBlocked(updatePayload))
      });

      if (!fallback.ok) {
        const fallbackDetails = await readSupabaseError(fallback);
        return {
          ok: false,
          status: fallback.status,
          error: `Could not update user${fallbackDetails ? `: ${fallbackDetails}` : ""}`
        };
      }
    } else {
      return {
        ok: false,
        status: updated.status,
        error: `Could not update user${details ? `: ${details}` : ""}`
      };
    }
  }

  const refreshed = await listAdminEntries(authHeader);
  return {
    ...refreshed,
    updatedName: nextName
  };
}

async function deleteAdminEntry(authHeader, body) {
  const entriesResult = await listAdminEntries(authHeader);
  if (!entriesResult.ok) return entriesResult;

  const name = String(body.name || "").trim();

  if (!name) {
    return {
      ok: false,
      status: 400,
      error: "Name is required"
    };
  }

  const writeAuthHeader = supabaseWriteAuthHeader(authHeader);
  const deleted = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leaderboard_entries?name=eq.${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      authorization: writeAuthHeader
    }
  });

  if (!deleted.ok) {
    const details = await readSupabaseError(deleted);
    return {
      ok: false,
      status: deleted.status,
      error: `Could not delete user${details ? `: ${details}` : ""}`
    };
  }

  return listAdminEntries(authHeader);
}

async function replaceAdminEntries(authHeader, entries) {
  const cleared = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leaderboard_entries?rank=gte.0`, {
    method: "DELETE",
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      authorization: authHeader
    }
  });

  if (!cleared.ok) {
    return {
      ok: false,
      status: cleared.status,
      error: "Could not update leaderboard"
    };
  }

  const now = new Date().toISOString();
  const rows = entries
    .map((entry) => ({
      name: entry.name,
      wagered: numberFrom(entry.wagered),
      baseline_wager: numberFrom(entry.baselineWager),
      current_wager: numberFrom(entry.currentWager ?? entry.wagered),
      deposits: 0,
      bets: 0,
      profit: 0,
      commission_generated: 0,
      first_seen: null,
      last_seen: null,
      blocked: Boolean(entry.blocked),
      avatar: entry.avatar || null,
      updated_at: now
    }))
    .sort((a, b) => b.wagered - a.wagered)
    .map((entry, index) => ({
      ...entry,
      rank: index + 1
    }));

  if (!rows.length) {
    return {
      ok: true,
      entries: []
    };
  }

  const insertResult = await insertLeaderboardRows(authHeader, rows);

  if (!insertResult.ok) {
    return {
      ok: false,
      status: insertResult.status,
      error: `Could not save leaderboard${insertResult.error ? `: ${insertResult.error}` : ""}`
    };
  }

  return listAdminEntries(authHeader);
}

function supabaseWriteAuthHeader(authHeader) {
  return process.env.SUPABASE_SERVICE_ROLE_KEY ? `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` : authHeader;
}

function stripBlocked(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stripBlocked(item));
  }

  const copy = { ...value };
  delete copy.blocked;
  return copy;
}

function isMissingBlockedColumn(message) {
  const value = String(message || "").toLowerCase();
  return value.includes("blocked") && (value.includes("schema cache") || value.includes("column"));
}

async function readSupabaseError(response) {
  try {
    const text = await response.text();
    if (!text) return "";

    try {
      const payload = JSON.parse(text);
      return payload.message || payload.details || payload.hint || text;
    } catch {
      return text.slice(0, 180);
    }
  } catch {
    return "";
  }
}

async function saveSupabaseLeaderboard(leaderboard, authHeader, options = { mode: "refresh" }, authContext = {}) {
  if (!authContext.trustedImport) {
    const user = await readSupabaseUser(authHeader);

    if (!user.ok) {
      return {
        ok: false,
        status: 401,
        error:
          "Admin login expired or is invalid. Open the admin panel again and drag the updated bookmarklet into Chrome."
      };
    }

    if (!(await isAdminUser(authHeader, user.email))) {
      return {
        ok: false,
        status: 403,
        error: "This email is not enabled as an admin"
      };
    }
  }

  const existingBaselines = options.mode === "refresh" ? await readSupabaseBaselines(authHeader) : new Map();
  const existingFlags = await readSupabaseEntryFlags(authHeader);
  const weekStartedAt = new Date();
  const weekEndsAt = new Date(weekStartedAt.getTime() + 7 * 24 * 60 * 60 * 1000);

  if (options.mode === "start") {
    const settingsSaved = await saveSupabaseWeekSettings(authHeader, {
      pot: options.pot,
      startedAt: weekStartedAt.toISOString(),
      endsAt: weekEndsAt.toISOString()
    });

    if (!settingsSaved.ok) {
      return settingsSaved;
    }
  }

  const cleared = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leaderboard_entries?rank=gte.0`, {
    method: "DELETE",
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      authorization: authHeader
    }
  });

  if (!cleared.ok) {
    return {
      ok: false,
      status: cleared.status,
      error: "Could not clear the old leaderboard"
    };
  }

  const now = new Date().toISOString();
  const rows = leaderboard
    .map((entry) => {
      const baseline = options.mode === "start" ? entry.wagered : existingBaselines.get(entry.name) ?? entry.wagered;
      const weeklyWager = Math.max(entry.wagered - baseline, 0);

      return {
        name: entry.name,
        wagered: weeklyWager,
        current_wager: entry.wagered,
        baseline_wager: baseline,
        deposits: entry.deposits,
        bets: entry.bets,
        profit: entry.profit,
        commission_generated: entry.commissionGenerated,
        first_seen: entry.firstSeen,
        last_seen: entry.lastSeen,
        blocked: Boolean(existingFlags.get(entry.name)?.blocked),
        avatar: entry.avatar,
        updated_at: now
      };
    })
    .sort((a, b) => b.wagered - a.wagered)
    .map((entry, index) => ({
      ...entry,
      rank: index + 1
    }));

  const insertResult = await insertLeaderboardRows(authHeader, rows);

  if (!insertResult.ok) {
    return {
      ok: false,
      status: insertResult.status,
      error: `Could not save the new leaderboard${insertResult.error ? `: ${insertResult.error}` : ""}`
    };
  }

  return {
    ok: true
  };
}

async function readSupabaseEntryFlags(authHeader) {
  const flags = new Map();

  try {
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leaderboard_entries?select=name,blocked`, {
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        authorization: authHeader
      }
    });

    if (!response.ok) return flags;

    const rows = await response.json();
    rows.forEach((row) => {
      flags.set(row.name, {
        blocked: Boolean(row.blocked)
      });
    });
  } catch {
    return flags;
  }

  return flags;
}

async function readSupabaseBaselines(authHeader) {
  const baselines = new Map();

  try {
    let response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/leaderboard_entries?select=name,baseline_wager,current_wager,wagered`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY,
          authorization: authHeader
        }
      }
    );

    if (response.status === 400) {
      response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leaderboard_entries?select=name,wagered`, {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY,
          authorization: authHeader
        }
      });
    }

    if (!response.ok) {
      return baselines;
    }

    const rows = await response.json();
    for (const row of rows) {
      baselines.set(row.name, solAmountFrom(row.baseline_wager ?? row.current_wager ?? row.wagered));
    }
  } catch {
    return baselines;
  }

  return baselines;
}

async function saveSupabaseWeekSettings(authHeader, week) {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leaderboard_settings?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      authorization: authHeader,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({
      id: 1,
      pot: week.pot,
      started_at: week.startedAt,
      ends_at: week.endsAt,
      updated_at: new Date().toISOString()
    })
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: "Could not save week settings"
    };
  }

  return {
    ok: true
  };
}

async function readSupabaseUser(authHeader) {
  try {
    const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        authorization: authHeader
      }
    });

    if (!response.ok) {
      return {
        ok: false
      };
    }

    const user = await response.json();
    return {
      ok: Boolean(user.email),
      email: user.email || ""
    };
  } catch {
    return {
      ok: false
    };
  }
}

function normalizeSolPumpPayload(payload) {
  const rows =
    (Array.isArray(payload) ? payload : null) ||
    payload?.leaderboard ||
    payload?.affiliates ||
    payload?.data?.leaderboard ||
    payload?.data?.affiliates ||
    payload?.data ||
    [];

  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((item, index) => {
      const wagered = solAmountFrom(item.wagered ?? item.wager ?? item.totalWagered ?? item.volume);
      const commissionGenerated = solAmountFrom(
        item.commissionGenerated ??
          item.commission_generated ??
          item.comissionGenerated ??
          item.generatedCommission ??
          item.commission ??
          item.revenue ??
          item.profit ??
          item.netProfit ??
          item.pnl
      );

      return {
        rank: numberFrom(item.rank) || index + 1,
        name: String(item.username ?? item.name ?? item.affiliate ?? item.player ?? `Affiliate ${index + 1}`),
        wagered,
        deposits: solAmountFrom(item.deposits ?? item.totalDeposits ?? item.depositAmount),
        bets: numberFrom(item.bets ?? item.totalBets ?? item.betCount),
        profit: commissionGenerated,
        commissionGenerated,
        firstSeen: item.firstSeen ?? item.first_seen ?? item.createdAt ?? item.created_at ?? null,
        lastSeen: item.lastSeen ?? item.last_seen ?? item.updatedAt ?? item.updated_at ?? null,
        avatar: item.avatar ?? item.avatarUrl ?? item.image ?? null
      };
    })
    .sort((a, b) => b.wagered - a.wagered)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function numberFrom(value) {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function solAmountFrom(value) {
  const numeric = numberFrom(value);
  return Math.abs(numeric) >= 1_000_000 ? numeric / 1_000_000_000 : numeric;
}

async function sendStatic(pathname, response) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const extension = path.extname(filePath);
  const content = await readFile(filePath);
  response.writeHead(200, {
    "content-type": mimeTypes[extension] || "application/octet-stream",
    "cache-control": "no-store"
  });
  response.end(content);
}

function sendJson(response, statusCode, payload, request = null) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(request),
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendCors(request, response, statusCode) {
  response.writeHead(statusCode, {
    ...corsHeaders(request),
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "cache-control": "no-store"
  });
  response.end();
}

function corsHeaders(request) {
  const origin = request?.headers?.origin || "";
  const allowedOrigins = allowedCorsOrigins();
  const fallbackOrigin = allowedOrigins[0] || "http://localhost:3000";

  if (!origin) {
    return {
      "access-control-allow-origin": fallbackOrigin,
      vary: "Origin"
    };
  }

  return {
    "access-control-allow-origin": allowedOrigins.includes(origin) ? origin : fallbackOrigin,
    vary: "Origin"
  };
}

function allowedCorsOrigins() {
  return [
    process.env.PUBLIC_BASE_URL,
    "https://solpump.io",
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ]
    .filter(Boolean)
    .map((origin) => origin.replace(/\/$/, ""));
}

function isRateLimited(request, maxPerMinute) {
  const ip = clientIp(request);
  const key = `${ip}:${request.url?.split("?")[0] || "/"}`;
  const now = Date.now();
  const entry = rateMap.get(key) || {
    count: 0,
    reset: now + 60_000
  };

  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + 60_000;
  }

  entry.count += 1;
  rateMap.set(key, entry);

  if (rateMap.size > 2000) {
    for (const [entryKey, value] of rateMap.entries()) {
      if (now > value.reset) {
        rateMap.delete(entryKey);
      }
    }
  }

  return entry.count > maxPerMinute;
}

function clientIp(request) {
  return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) {
        request.destroy();
        reject(new Error("Request ist zu gross"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;

  const content = await readFile(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const demoLeaderboard = [
  {
    rank: 1,
    name: "PommesPrime",
    wagered: 128430.55,
    deposits: 14800,
    bets: 8412,
    profit: 6200,
    avatar: null
  },
  {
    rank: 2,
    name: "KickKing",
    wagered: 96540.1,
    deposits: 12150,
    bets: 6720,
    profit: 4185,
    avatar: null
  },
  {
    rank: 3,
    name: "StakeRunner",
    wagered: 74890.75,
    deposits: 9900,
    bets: 5234,
    profit: 2915,
    avatar: null
  },
  {
    rank: 4,
    name: "SolSniper",
    wagered: 61220.25,
    deposits: 7800,
    bets: 4880,
    profit: 1850,
    avatar: null
  },
  {
    rank: 5,
    name: "BonusBasti",
    wagered: 45810.9,
    deposits: 6400,
    bets: 3021,
    profit: 940,
    avatar: null
  }
];
