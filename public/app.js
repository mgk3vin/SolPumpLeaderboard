const elements = {
  body: document.querySelector("#leaderboardBody"),
  podium: document.querySelector("#podium"),
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  refreshButton: document.querySelector("#refreshButton")
};

const solFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4
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

    const rows = (payload.leaderboard || []).slice(0, 10);
    renderPodium(rows.slice(0, 3));
    renderLeaderboard(rows);
    setStatus(
      payload.source === "demo" ? "demo" : "live",
      payload.source === "demo" ? "Demo data active" : "Live leaderboard"
    );
  } catch (error) {
    elements.podium.innerHTML = "";
    elements.body.innerHTML = `<tr><td colspan="3" class="empty-state">${escapeHtml(error.message)}</td></tr>`;
    setStatus("error", "Connection failed");
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function renderPodium(rows) {
  if (!rows.length) {
    elements.podium.innerHTML = '<div class="empty-state">No podium data yet.</div>';
    return;
  }

  const ordered = [rows[1], rows[0], rows[2]].filter(Boolean);
  elements.podium.innerHTML = ordered
    .map(
      (row) => `
        <article class="podium-card podium-rank-${row.rank}">
          <div class="podium-medal">#${row.rank}</div>
          <span class="avatar podium-avatar">${renderAvatar(row)}</span>
          <strong>${escapeHtml(row.name)}</strong>
          <span>${formatSol(row.wagered)}</span>
        </article>
      `
    )
    .join("");
}

function renderLeaderboard(rows) {
  if (!rows.length) {
    elements.body.innerHTML = '<tr><td colspan="3" class="empty-state">No affiliate data yet.</td></tr>';
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
        </tr>
      `
    )
    .join("");
}

function renderAvatar(row) {
  if (row.avatar) {
    return `<img src="${escapeAttribute(row.avatar)}" alt="" loading="lazy" />`;
  }

  return escapeHtml(row.name.slice(0, 1).toUpperCase());
}

function formatSol(value) {
  return `${solFormatter.format(Number(value || 0))} SOL`;
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
