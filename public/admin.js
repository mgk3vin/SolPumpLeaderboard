import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const elements = {
  loginForm: document.querySelector("#loginForm"),
  emailInput: document.querySelector("#emailInput"),
  passwordInput: document.querySelector("#passwordInput"),
  signOutButton: document.querySelector("#signOutButton"),
  adminPanel: document.querySelector("#adminPanel"),
  adminEmail: document.querySelector("#adminEmail"),
  adminStatus: document.querySelector("#adminStatus"),
  adminTabs: document.querySelectorAll(".admin-tab"),
  importPanel: document.querySelector("#importPanel"),
  managePanel: document.querySelector("#managePanel"),
  createUserForm: document.querySelector("#createUserForm"),
  createUserButton: document.querySelector("#createUserForm button[type='submit']"),
  newUserName: document.querySelector("#newUserName"),
  newUserWager: document.querySelector("#newUserWager"),
  adminEntriesBody: document.querySelector("#adminEntriesBody"),
  startWeekLink: document.querySelector("#startWeekLink"),
  bookmarkletLink: document.querySelector("#bookmarkletLink")
};

let supabase = null;
let config = null;
let currentToken = "";

boot();

async function boot() {
  config = await fetch("/api/config").then((response) => response.json());

  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    setStatus("Supabase is not configured yet.");
    return;
  }

  supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
  elements.loginForm.addEventListener("submit", signInWithPassword);
  elements.signOutButton.addEventListener("click", signOut);
  elements.createUserForm.addEventListener("submit", createUser);
  elements.adminTabs.forEach((tab) => tab.addEventListener("click", () => selectPanel(tab.dataset.panel)));
  elements.adminEntriesBody.addEventListener("click", handleEntryAction);

  const {
    data: { session }
  } = await supabase.auth.getSession();

  await renderSession(session);

  supabase.auth.onAuthStateChange((_event, session) => {
    renderSession(session);
  });
}

async function signInWithPassword(event) {
  event.preventDefault();
  const email = elements.emailInput.value.trim().toLowerCase();
  const password = elements.passwordInput.value;

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    setStatus(error.message);
    return;
  }

  setStatus("Signed in.");
}

async function renderSession(session) {
  const adminStatus = session ? await readAdminStatus(session.access_token) : { isAdmin: false, email: "" };
  const email = adminStatus.email || session?.user?.email?.toLowerCase() || "";
  const isAdmin = Boolean(adminStatus.isAdmin);

  elements.loginForm.hidden = Boolean(isAdmin);
  elements.adminPanel.hidden = !isAdmin;
  elements.signOutButton.hidden = !isAdmin;

  if (!session) {
    localStorage.removeItem("lordpommes_admin_token");
    currentToken = "";
    setStatus("Please sign in with an approved admin email.");
    return;
  }

  if (!isAdmin) {
    localStorage.removeItem("lordpommes_admin_token");
    currentToken = "";
    setStatus("This account is not enabled as an admin.");
    return;
  }

  localStorage.setItem("lordpommes_admin_token", session.access_token);
  currentToken = session.access_token;
  elements.adminEmail.textContent = email;

  const [startBookmarklet, refreshBookmarklet] = await Promise.all([
    fetch(`/api/bookmarklet?action=start&token=${encodeURIComponent(session.access_token)}`).then((response) =>
      response.json()
    ),
    fetch(`/api/bookmarklet?action=refresh&token=${encodeURIComponent(session.access_token)}`).then((response) =>
      response.json()
    )
  ]);

  if (!startBookmarklet.ok || !refreshBookmarklet.ok) {
    setStatus(startBookmarklet.error || refreshBookmarklet.error || "Could not create bookmarklets.");
    return;
  }

  elements.startWeekLink.href = startBookmarklet.bookmarklet;
  elements.bookmarkletLink.href = refreshBookmarklet.bookmarklet;
  setStatus(
    refreshBookmarklet.mode === "import-token"
      ? "Ready for SolPump import. Drag the updated bookmarks into Chrome once."
      : "Ready for SolPump import. Bookmark links expire with the admin login."
  );
  await loadEntries();
}

function selectPanel(panelId) {
  elements.importPanel.hidden = panelId !== "importPanel";
  elements.managePanel.hidden = panelId !== "managePanel";
  elements.adminTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.panel === panelId));

  if (panelId === "managePanel") {
    loadEntries();
  }
}

async function loadEntries() {
  if (!currentToken) return;

  elements.adminEntriesBody.innerHTML = '<tr><td colspan="5" class="empty-state">Loading users...</td></tr>';

  const payload = await adminRequest("/api/admin/entries");

  if (!payload.ok) {
    elements.adminEntriesBody.innerHTML = `<tr><td colspan="5" class="empty-state">${escapeHtml(payload.error)}</td></tr>`;
    return;
  }

  renderEntries(payload.entries || []);
}

function renderEntries(entries, highlightName = "") {
  if (!entries.length) {
    elements.adminEntriesBody.innerHTML = '<tr><td colspan="5" class="empty-state">No users yet.</td></tr>';
    return;
  }

  elements.adminEntriesBody.innerHTML = entries
    .map(
      (entry) => `
        <tr class="${entry.name === highlightName ? "entry-highlight" : ""}" data-name="${escapeAttribute(entry.name)}" data-blocked="${entry.blocked ? "true" : "false"}">
          <td><span class="admin-rank">#${entry.rank}</span></td>
          <td>
            <input class="entry-name" type="text" value="${escapeAttribute(entry.name)}" />
          </td>
          <td>
            <input class="entry-wager" type="number" min="0" step="0.0001" value="${entry.wagered}" />
          </td>
          <td>
            <span class="status-pill ${entry.blocked ? "blocked" : "active"}">${entry.blocked ? "Blocked" : "Active"}</span>
          </td>
          <td>
            <div class="entry-actions">
              <button type="button" data-action="save">Save</button>
              <button type="button" data-action="toggle-block" data-blocked="${entry.blocked ? "true" : "false"}">
                ${entry.blocked ? "Unblock" : "Block"}
              </button>
              <button class="danger-button" type="button" data-action="delete">Delete</button>
            </div>
          </td>
        </tr>
      `
    )
    .join("");
}

async function createUser(event) {
  event.preventDefault();
  const userName = elements.newUserName.value.trim();
  const originalText = elements.createUserButton.textContent;

  elements.createUserButton.disabled = true;
  elements.createUserButton.textContent = "Creating...";

  const payload = await adminRequest("/api/admin/entries", {
    method: "POST",
    body: {
      name: userName,
      wagered: elements.newUserWager.value,
      blocked: false
    }
  });

  if (!payload.ok) {
    setStatus(payload.error);
    elements.createUserButton.disabled = false;
    elements.createUserButton.textContent = originalText;
    return;
  }

  elements.createUserForm.reset();
  elements.createUserButton.textContent = "Created";
  setStatus(`${payload.createdName || userName} created and added to the leaderboard.`);
  renderEntries(payload.entries || [], payload.createdName || userName);

  window.setTimeout(() => {
    elements.createUserButton.disabled = false;
    elements.createUserButton.textContent = originalText;
    elements.adminEntriesBody.querySelector(".entry-highlight")?.classList.remove("entry-highlight");
  }, 1200);
}

async function handleEntryAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const row = button.closest("tr");
  const name = row.dataset.name;

  if (button.dataset.action === "delete") {
    button.disabled = true;
    button.textContent = "Deleting...";
    const payload = await adminRequest("/api/admin/entries", {
      method: "DELETE",
      body: { name }
    });

    if (!payload.ok) {
      setStatus(payload.error);
      return;
    }

    setStatus("User deleted.");
    renderEntries(payload.entries || []);
    return;
  }

  const nextBlocked =
    button.dataset.action === "toggle-block" ? button.dataset.blocked !== "true" : row.dataset.blocked === "true";
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = button.dataset.action === "toggle-block" ? "Updating..." : "Saving...";

  const payload = await adminRequest("/api/admin/entries", {
    method: "PATCH",
    body: {
      name,
      nextName: row.querySelector(".entry-name").value,
      wagered: row.querySelector(".entry-wager").value,
      blocked: nextBlocked
    }
  });

  if (!payload.ok) {
    setStatus(payload.error);
    button.disabled = false;
    button.textContent = originalText;
    return;
  }

  setStatus(button.dataset.action === "toggle-block" ? "User status updated." : "User updated.");
  renderEntries(payload.entries || [], payload.updatedName || row.querySelector(".entry-name").value);
}

async function adminRequest(url, options = {}) {
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        authorization: `Bearer ${currentToken}`,
        ...(options.body ? { "content-type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    return response.json();
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

async function readAdminStatus(token) {
  try {
    const response = await fetch("/api/admin-status", {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      return {
        isAdmin: false,
        email: ""
      };
    }

    return response.json();
  } catch {
    return {
      isAdmin: false,
      email: ""
    };
  }
}

async function signOut() {
  await supabase.auth.signOut();
  localStorage.removeItem("lordpommes_admin_token");
  currentToken = "";
  setStatus("Signed out.");
}

function setStatus(message) {
  elements.adminStatus.textContent = message;
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
