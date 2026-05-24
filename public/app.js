const elements = {
  body: document.querySelector("#leaderboardBody"),
  totalWager: document.querySelector("#totalWager"),
  totalAffiliates: document.querySelector("#totalAffiliates"),
  totalCommission: document.querySelector("#totalCommission"),
  lastUpdate: document.querySelector("#lastUpdate"),
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  refreshButton: document.querySelector("#refreshButton")
};

const solFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4
});

const compactSolFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4
});

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});

elements.refreshButton.addEventListener("click", loadLeaderboard);
loadLeaderboard();

async function loadLeaderboard() {
  setStatus("loading", "Loading data");
  elements.refreshButton.disabled = true;

  try {
    const response = await fetch("/api/leaderboard");
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Leaderboard could not be loaded");
    }

    renderLeaderboard(payload.leaderboard || []);
    renderSummary(payload);
    setStatus(
      payload.source === "demo" ? "demo" : "live",
      payload.source === "demo"
        ? "Demo data active"
        : payload.source === "browser"
          ? "Loaded from browser import"
          : payload.source === "supabase"
            ? "Live from Supabase"
            : "Live with SolPump"
    );
  } catch (error) {
    elements.body.innerHTML = `<tr><td colspan="6" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
    setStatus("error", "Connection failed");
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function renderLeaderboard(rows) {
  if (!rows.length) {
    elements.body.innerHTML = '<tr><td colspan="6" class="empty-state">No affiliate data yet.</td></tr>';
    return;
  }

  elements.body.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td class="rank">#${row.rank}</td>
          <td>
            <div class="affiliate">
              <span class="avatar">${renderAvatar(row)}</span>
              <span>${escapeHtml(row.name)}</span>
            </div>
          </td>
          <td>${formatSol(row.wagered)}</td>
          <td class="positive">${formatSol(row.commissionGenerated ?? row.profit)}</td>
          <td>${formatDateTime(row.firstSeen)}</td>
          <td>${formatDateTime(row.lastSeen)}</td>
        </tr>
      `
    )
    .join("");
}

function renderSummary(payload) {
  const rows = payload.leaderboard || [];
  const totalWager = rows.reduce((sum, row) => sum + (row.wagered || 0), 0);
  const totalCommission = rows.reduce((sum, row) => sum + (row.commissionGenerated ?? row.profit ?? 0), 0);

  elements.totalWager.textContent = formatSol(totalWager, compactSolFormatter);
  elements.totalAffiliates.textContent = numberFormatter.format(rows.length);
  elements.totalCommission.textContent = formatSol(totalCommission, compactSolFormatter);
  elements.lastUpdate.textContent = formatDateTime(payload.updatedAt);
}

function renderAvatar(row) {
  if (row.avatar) {
    return `<img src="${escapeAttribute(row.avatar)}" alt="" loading="lazy" />`;
  }

  return escapeHtml(
    row.name
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase()
  );
}

function formatSol(value, formatter = solFormatter) {
  return `${formatter.format(Number(value || 0))} SOL`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);

  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function setStatus(type, text) {
  elements.statusDot.className = `status-dot ${type === "live" ? "live" : ""} ${type === "error" ? "error" : ""}`;
  elements.statusText.textContent = text;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[char];
  });
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
