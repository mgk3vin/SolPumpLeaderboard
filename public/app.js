const elements = {
  body: document.querySelector("#leaderboardBody"),
  totalWager: document.querySelector("#totalWager"),
  totalAffiliates: document.querySelector("#totalAffiliates"),
  totalBets: document.querySelector("#totalBets"),
  lastUpdate: document.querySelector("#lastUpdate"),
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  refreshButton: document.querySelector("#refreshButton")
};

const currencyFormatter = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0
});

const numberFormatter = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 0
});

elements.refreshButton.addEventListener("click", loadLeaderboard);
loadLeaderboard();

async function loadLeaderboard() {
  setStatus("loading", "Daten werden geladen");
  elements.refreshButton.disabled = true;

  try {
    const response = await fetch("/api/leaderboard");
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || "Leaderboard konnte nicht geladen werden");
    }

    renderLeaderboard(payload.leaderboard || []);
    renderSummary(payload);
    setStatus(
      payload.source === "demo" ? "demo" : "live",
      payload.source === "demo"
        ? "Demo-Daten aktiv"
        : payload.source === "browser"
          ? "Aus Browser-Import geladen"
          : payload.source === "supabase"
            ? "Live aus Supabase"
          : "Live mit SolPump verbunden"
    );
  } catch (error) {
    elements.body.innerHTML = `<tr><td colspan="6" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
    setStatus("error", "Verbindung fehlgeschlagen");
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function renderLeaderboard(rows) {
  if (!rows.length) {
    elements.body.innerHTML = '<tr><td colspan="6" class="empty-state">Noch keine Affiliate-Daten vorhanden.</td></tr>';
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
          <td>${currencyFormatter.format(row.wagered || 0)}</td>
          <td>${currencyFormatter.format(row.deposits || 0)}</td>
          <td>${numberFormatter.format(row.bets || 0)}</td>
          <td class="${(row.profit || 0) < 0 ? "negative" : "positive"}">${currencyFormatter.format(row.profit || 0)}</td>
        </tr>
      `
    )
    .join("");
}

function renderSummary(payload) {
  const rows = payload.leaderboard || [];
  const totalWager = rows.reduce((sum, row) => sum + (row.wagered || 0), 0);
  const totalBets = rows.reduce((sum, row) => sum + (row.bets || 0), 0);

  elements.totalWager.textContent = currencyFormatter.format(totalWager);
  elements.totalAffiliates.textContent = numberFormatter.format(rows.length);
  elements.totalBets.textContent = numberFormatter.format(totalBets);
  elements.lastUpdate.textContent = new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(payload.updatedAt));
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
