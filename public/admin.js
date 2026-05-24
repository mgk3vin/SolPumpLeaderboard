import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const elements = {
  loginForm: document.querySelector("#loginForm"),
  emailInput: document.querySelector("#emailInput"),
  passwordInput: document.querySelector("#passwordInput"),
  signOutButton: document.querySelector("#signOutButton"),
  adminPanel: document.querySelector("#adminPanel"),
  adminEmail: document.querySelector("#adminEmail"),
  adminStatus: document.querySelector("#adminStatus"),
  bookmarkletLink: document.querySelector("#bookmarkletLink")
};

let supabase = null;
let config = null;

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
    setStatus("Please sign in with an approved admin email.");
    return;
  }

  if (!isAdmin) {
    localStorage.removeItem("lordpommes_admin_token");
    setStatus("This account is not enabled as an admin.");
    return;
  }

  localStorage.setItem("lordpommes_admin_token", session.access_token);
  elements.adminEmail.textContent = email;

  const bookmarklet = await fetch(`/api/bookmarklet?token=${encodeURIComponent(session.access_token)}`).then((response) =>
    response.json()
  );
  elements.bookmarkletLink.href = bookmarklet.bookmarklet;
  setStatus("Ready for SolPump import.");
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
  setStatus("Signed out.");
}

function setStatus(message) {
  elements.adminStatus.textContent = message;
}
