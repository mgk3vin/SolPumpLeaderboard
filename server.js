import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);
let browserIngest = null;

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

    if (request.method === "OPTIONS") {
      sendCors(response, 204);
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

    if (url.pathname === "/api/bookmarklet") {
      sendBookmarklet(response, url);
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

    await sendStatic(url.pathname, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, {
      ok: false,
      error: "Internal server error"
    });
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
        leaderboard: supabaseResult.leaderboard
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
      leaderboard: browserIngest.leaderboard
    });
    return;
  }

  if (!endpoint || !cookie) {
    sendJson(response, 200, {
      ok: true,
      source: "demo",
      updatedAt: new Date().toISOString(),
      leaderboard: demoLeaderboard
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
    leaderboard
  });
}

async function receiveBrowserIngest(request, response) {
  const body = await readRequestBody(request);
  const payload = JSON.parse(body);
  const leaderboard = normalizeSolPumpPayload(payload);
  const authHeader = request.headers.authorization || "";

  if (hasSupabaseConfig() && authHeader.startsWith("Bearer ")) {
    const saved = await saveSupabaseLeaderboard(leaderboard, authHeader);

    if (!saved.ok) {
      sendJson(response, saved.status || 500, {
        ok: false,
        error: saved.error || "Supabase import failed"
      });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      source: "supabase",
      rows: leaderboard.length
    });
    return;
  }

  browserIngest = {
    updatedAt: new Date().toISOString(),
    leaderboard
  };

  sendJson(response, 200, {
    ok: true,
    rows: leaderboard.length
  });
}

function sendBookmarklet(response, requestUrl) {
  const solPumpPath = new URL(process.env.SOLPUMP_API_URL || "https://solpump.io/api/v1/affiliate?sort=Most+Wagered").pathname;
  const solPumpQuery = new URL(process.env.SOLPUMP_API_URL || "https://solpump.io/api/v1/affiliate?sort=Most+Wagered").search;
  const apiPath = `${solPumpPath}${solPumpQuery}`;
  const ingestUrl = process.env.PUBLIC_BASE_URL ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/ingest` : `http://localhost:${port}/api/ingest`;
  const token = requestUrl.searchParams.get("token") || "";
  const tokenExpression = token ? JSON.stringify(token) : `localStorage.getItem("lordpommes_admin_token")`;
  const script = `(async()=>{const t=${tokenExpression};if(!t){alert("Please sign in to the admin panel first.");return;}const r=await fetch(${JSON.stringify(apiPath)},{credentials:"include"});const j=await r.json();const p=await fetch(${JSON.stringify(ingestUrl)},{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+t},body:JSON.stringify(j)});const o=await p.json();if(!p.ok||!o.ok)throw new Error(o.error||"Import failed");alert("LordpommesX2 leaderboard updated: "+o.rows+" affiliates");})().catch(e=>alert("Leaderboard import failed: "+e.message));`;

  sendJson(response, 200, {
    ok: true,
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
  const isAdmin = user.ok && parseAdminEmails().includes(user.email.toLowerCase());

  sendJson(response, 200, {
    ok: true,
    isAdmin,
    email: user.email || ""
  });
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

function hasSupabaseConfig() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}

function parseAdminEmails() {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

async function readSupabaseLeaderboard() {
  try {
    let response = await fetchSupabaseLeaderboard(
      "rank,name,wagered,deposits,bets,profit,commission_generated,first_seen,last_seen,avatar,updated_at"
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
      avatar: row.avatar
    }));

    return {
      ok: true,
      updatedAt: rows[0]?.updated_at || new Date().toISOString(),
      leaderboard
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

function fetchSupabaseLeaderboard(select) {
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/leaderboard_entries?select=${select}&order=rank.asc`, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`
    }
  });
}

async function saveSupabaseLeaderboard(leaderboard, authHeader) {
  const user = await readSupabaseUser(authHeader);

  if (!user.ok) {
    return {
      ok: false,
      status: 401,
      error: "Admin login expired or is invalid"
    };
  }

  const adminEmails = parseAdminEmails();
  if (!adminEmails.includes(user.email.toLowerCase())) {
    return {
      ok: false,
      status: 403,
      error: "This email is not enabled as an admin"
    };
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
  const rows = leaderboard.map((entry) => ({
    rank: entry.rank,
    name: entry.name,
    wagered: entry.wagered,
    deposits: entry.deposits,
    bets: entry.bets,
    profit: entry.profit,
    commission_generated: entry.commissionGenerated,
    first_seen: entry.firstSeen,
    last_seen: entry.lastSeen,
    avatar: entry.avatar,
    updated_at: now
  }));

  const inserted = await fetch(`${process.env.SUPABASE_URL}/rest/v1/leaderboard_entries`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      authorization: authHeader,
      "content-type": "application/json",
      prefer: "return=minimal"
    },
    body: JSON.stringify(rows)
  });

  if (!inserted.ok) {
    return {
      ok: false,
      status: inserted.status,
      error: "Could not save the new leaderboard"
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

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendCors(response, statusCode) {
  response.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "cache-control": "no-store"
  });
  response.end();
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
