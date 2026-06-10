// @ts-check
/**
 * Claude Analyzer — browser UI.
 *
 * Talks to the local JSON API in src/server.ts. Everything rendered from file
 * contents is inserted as text (never innerHTML), except a small, deliberately
 * minimal Markdown renderer that escapes first — so untrusted file contents
 * cannot inject script into this page.
 */

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

/** App state. */
const state = {
  allowWrite: false,
  current: /** @type {null | object} */ (null), // last FileRead
  editing: false,
  watchPaused: false, // when true, suppress flash highlights (activity log still records)
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function api(path) {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function fmtTime(ms) {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

function iconFor(entry) {
  if (entry.kind === "dir") return "📁";
  const ext = (entry.name.split(".").pop() || "").toLowerCase();
  if (entry.name.endsWith(".jsonl")) return "🧵";
  if (ext === "json") return "⚙️";
  if (ext === "md" || ext === "markdown") return "📝";
  if (["jpg", "jpeg", "png", "gif", "webp", "pdf"].includes(ext)) return "🖼";
  if (["log", "out", "err"].includes(ext)) return "📜";
  return "📄";
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

async function buildTree() {
  const treeEl = $("#tree");
  treeEl.innerHTML = "";
  const rootContainer = document.createElement("div");
  rootContainer.className = "tree-children";
  rootContainer.style.marginLeft = "0";
  rootContainer.style.borderLeft = "none";
  treeEl.appendChild(rootContainer);
  await expandInto(rootContainer, "");
}

/** Load the children of `relPath` and render them into `container`. */
async function expandInto(container, relPath) {
  container.dataset.dir = relPath;
  container.innerHTML = "";
  let data;
  try {
    data = await api(`/api/list?path=${encodeURIComponent(relPath)}`);
  } catch (e) {
    container.textContent = `Error: ${e.message}`;
    return;
  }
  for (const entry of data.entries) {
    container.appendChild(renderNode(entry));
  }
  if (data.entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tree-loading";
    empty.textContent = "(empty)";
    container.appendChild(empty);
  }
  container.dataset.loaded = "1";
}

function renderNode(entry) {
  const node = document.createElement("div");
  node.className = "tree-node";

  const row = document.createElement("div");
  row.className = "tree-row";
  row.dataset.path = entry.path;

  const twisty = document.createElement("span");
  twisty.className = "twisty";
  twisty.textContent = entry.kind === "dir" ? "▸" : "";

  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = iconFor(entry);

  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = entry.name;

  row.append(twisty, icon, lbl);
  if (entry.sensitive) {
    const s = document.createElement("span");
    s.className = "sens";
    s.textContent = "🔒";
    s.title = "sensitive — redacted by default";
    row.appendChild(s);
  }
  node.appendChild(row);

  if (entry.kind === "dir") {
    const children = document.createElement("div");
    children.className = "tree-children hidden";
    children.dataset.dir = entry.path;
    node.appendChild(children);
    let loaded = false;
    row.addEventListener("click", async () => {
      const open = children.classList.toggle("hidden");
      twisty.textContent = open ? "▸" : "▾";
      if (!open && !loaded) {
        children.innerHTML = '<div class="tree-loading">…</div>';
        await expandInto(children, entry.path);
        loaded = true;
      }
    });
  } else {
    row.addEventListener("click", () => {
      document.querySelectorAll(".tree-row.active").forEach((r) => r.classList.remove("active"));
      row.classList.add("active");
      openFile(entry.path, false);
    });
  }
  return node;
}

// ---------------------------------------------------------------------------
// File viewing
// ---------------------------------------------------------------------------

async function openFile(relPath, reveal) {
  setEditing(false);
  closeDrawers(); // close any open slide-out drawer
  const viewer = $("#viewer");
  viewer.innerHTML = '<div class="empty">Loading…</div>';
  let data;
  try {
    data = await api(`/api/file?path=${encodeURIComponent(relPath)}${reveal ? "&reveal=1" : ""}`);
  } catch (e) {
    viewer.innerHTML = `<div class="empty">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  state.current = data;
  renderBreadcrumbs(relPath);
  renderToolbar(data);
  renderBanner(data);
  renderContent(data);
  // Flash the file's folder in the tree so you can see where it lives.
  flashAncestorFolder(relPath);
}

function renderBreadcrumbs(relPath) {
  const bc = $("#breadcrumbs");
  bc.innerHTML = "";
  const parts = relPath.split("/");
  const rootLink = document.createElement("a");
  rootLink.textContent = ".claude";
  bc.appendChild(rootLink);
  parts.forEach((p, i) => {
    bc.appendChild(document.createTextNode(" / "));
    const span = document.createElement(i === parts.length - 1 ? "span" : "a");
    span.textContent = p;
    bc.appendChild(span);
  });
}

function renderToolbar(data) {
  $("#toolbar").classList.remove("hidden");
  $("#file-meta").textContent = `${data.type} · ${fmtBytes(data.size)} · ${fmtTime(data.mtime)}`;

  const reveal = $("#btn-reveal");
  const edit = $("#btn-edit");
  const save = $("#btn-save");
  const cancel = $("#btn-cancel");

  // Reveal shown only when something is hidden and not yet revealed.
  if ((data.redacted || data.sensitive) && !data.revealed && data.type !== "binary") {
    reveal.classList.remove("hidden");
  } else {
    reveal.classList.add("hidden");
  }

  // Wrap toggle is relevant for any text-ish content.
  $("#btn-wrap").classList.toggle("hidden", data.type === "binary");

  // Edit only for text-ish files when server allows writing.
  if (state.allowWrite && data.type !== "binary") {
    edit.classList.remove("hidden");
  } else {
    edit.classList.add("hidden");
  }
  save.classList.add("hidden");
  cancel.classList.add("hidden");
}

function renderBanner(data) {
  const banner = $("#banner");
  if (data.revealed) {
    banner.className = "banner danger";
    banner.textContent = "⚠ Showing RAW contents — secrets are visible. Be careful copying or sharing.";
    banner.classList.remove("hidden");
  } else if (data.sensitive) {
    banner.className = "banner danger";
    banner.textContent = "🔒 This file is treated as sensitive; all values are redacted. Use Reveal to show raw contents.";
    banner.classList.remove("hidden");
  } else if (data.redacted) {
    banner.className = "banner";
    banner.textContent = "Some values that look like secrets were redacted. Use Reveal to show raw contents.";
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

function renderContent(data) {
  const viewer = $("#viewer");
  viewer.innerHTML = "";
  if (data.type === "binary") {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = data.note || "Binary file.";
    viewer.appendChild(d);
    return;
  }
  if (data.type === "jsonl") {
    viewer.appendChild(renderJsonl(data.content));
    return;
  }
  if (data.type === "markdown") {
    const md = document.createElement("div");
    md.className = "md";
    md.innerHTML = renderMarkdown(data.content);
    viewer.appendChild(md);
    return;
  }
  if (data.type === "json") {
    viewer.appendChild(renderJson(data.content));
    return;
  }
  // plain text
  const pre = document.createElement("pre");
  pre.className = "code";
  pre.textContent = data.content;
  viewer.appendChild(pre);
}

function renderJson(text) {
  const pre = document.createElement("pre");
  pre.className = "code";
  try {
    pre.textContent = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    pre.textContent = text; // show as-is if not strictly valid (e.g. redacted)
  }
  return pre;
}

/** Render a JSONL document as a list of collapsible records. */
function renderJsonl(text) {
  const wrap = document.createElement("div");
  const lines = text.split("\n");
  let n = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    n++;
    let obj = null;
    try {
      obj = JSON.parse(line);
    } catch {
      /* keep raw */
    }
    wrap.appendChild(renderJsonlLine(n, line, obj));
  }
  if (n === 0) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "(no records)";
    wrap.appendChild(e);
  }
  return wrap;
}

function renderJsonlLine(num, raw, obj) {
  const el = document.createElement("div");
  el.className = "jsonl-line";

  const head = document.createElement("div");
  head.className = "jsonl-head";

  const numEl = document.createElement("span");
  numEl.className = "jsonl-num";
  numEl.textContent = String(num);

  const role = obj && (obj.role || obj.type || obj.event) ? String(obj.role || obj.type || obj.event) : "raw";
  const tag = document.createElement("span");
  tag.className = `jsonl-tag ${role}`;
  tag.textContent = role;

  const preview = document.createElement("span");
  preview.className = "jsonl-preview";
  preview.textContent = previewOf(obj, raw);

  head.append(numEl, tag, preview);

  const body = document.createElement("div");
  body.className = "jsonl-body hidden";
  const pre = document.createElement("pre");
  pre.className = "code";
  pre.textContent = obj ? JSON.stringify(obj, null, 2) : raw;
  body.appendChild(pre);

  head.addEventListener("click", () => body.classList.toggle("hidden"));
  el.append(head, body);
  return el;
}

function previewOf(obj, raw) {
  if (!obj) return raw.slice(0, 200);
  // Common Claude transcript shapes.
  const m = obj.message || obj;
  let content = m.content ?? obj.summary ?? obj.text ?? "";
  if (Array.isArray(content)) {
    content = content
      .map((c) => (typeof c === "string" ? c : c.text || c.type || ""))
      .join(" ");
  }
  if (typeof content !== "string") content = JSON.stringify(content);
  return content.slice(0, 200) || raw.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Minimal, safe Markdown (escapes first, then applies a tiny subset)
// ---------------------------------------------------------------------------

function renderMarkdown(src) {
  const escaped = escapeHtml(src);
  const lines = escaped.split("\n");
  let html = "";
  let inCode = false;
  let inList = false;
  for (let line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        html += "</code></pre>";
        inCode = false;
      } else {
        html += "<pre><code>";
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html += line + "\n";
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (inList) { html += "</ul>"; inList = false; }
      const level = h[1].length;
      html += `<h${level}>${inline(h[2])}</h${level}>`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`;
      continue;
    }
    if (inList) { html += "</ul>"; inList = false; }
    if (line.trim() === "") { html += ""; continue; }
    if (/^&gt;\s?/.test(line)) {
      html += `<blockquote>${inline(line.replace(/^&gt;\s?/, ""))}</blockquote>`;
      continue;
    }
    html += `<p>${inline(line)}</p>`;
  }
  if (inCode) html += "</code></pre>";
  if (inList) html += "</ul>";
  return html;
}

function inline(s) {
  // s is already HTML-escaped. Apply inline code, bold, italic, links.
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function setEditing(on) {
  state.editing = on;
  $("#btn-edit").classList.toggle("hidden", on || !state.allowWrite || !state.current || state.current.type === "binary");
  $("#btn-save").classList.toggle("hidden", !on);
  $("#btn-cancel").classList.toggle("hidden", !on);
  $("#btn-reveal").classList.toggle("hidden", on);
}

function startEdit() {
  const data = state.current;
  if (!data) return;
  // If editing a redacted view, warn that saving would persist the mask.
  if (data.redacted || data.sensitive) {
    showConfirm(
      "Edit redacted file?",
      "This file is shown with secrets redacted. If you edit and save now, the «redacted» placeholders will OVERWRITE the real values. Reveal the raw contents first if you want to preserve them. Continue editing the redacted version?",
      () => enterEditor(),
    );
    return;
  }
  enterEditor();
}

function enterEditor() {
  const data = state.current;
  if (!data) return;
  setEditing(true);
  const viewer = $("#viewer");
  viewer.innerHTML = "";
  const ta = document.createElement("textarea");
  ta.id = "editor";
  ta.value = data.content ?? "";
  ta.spellcheck = false;
  viewer.appendChild(ta);
  ta.focus();
}

function cancelEdit() {
  setEditing(false);
  if (state.current) renderContent(state.current);
}

function saveEdit() {
  const data = state.current;
  const ta = /** @type {HTMLTextAreaElement} */ ($("#editor"));
  if (!data || !ta) return;
  const content = ta.value;
  showConfirm(
    "Save changes?",
    `Write ${fmtBytes(new Blob([content]).size)} to “${data.path}”? A timestamped backup of the current file will be saved under .analyzer-backups/ first.`,
    async () => {
      try {
        const result = await apiPost("/api/file", { path: data.path, content });
        setEditing(false);
        const banner = $("#banner");
        banner.className = "banner ok";
        banner.textContent = `Saved ${fmtBytes(result.bytes)}.` + (result.backup ? ` Backup: ${result.backup}` : " (new file)");
        banner.classList.remove("hidden");
        await openFile(data.path, false);
      } catch (e) {
        const banner = $("#banner");
        banner.className = "banner danger";
        banner.textContent = `Save failed: ${e.message}`;
        banner.classList.remove("hidden");
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Server-Sent Events: live directory watch (flash on change) + dev hot-reload.
// ---------------------------------------------------------------------------

/**
 * Subscribe to the server event stream:
 *  - `fschange` — a file under the root changed → flash it in the tree and
 *    refresh the open file if it's the one that changed.
 *  - `reload` (dev) — a UI asset changed → reload the page.
 *  - reconnection (dev) — server restarted under `--watch` → reload the page.
 *  - `watcherror` — the OS watch failed (e.g. inotify limit) → show a notice.
 */
function setupEvents(cfg) {
  let bootId = null;
  const es = new EventSource("/api/events");
  // Reload only when the server's boot id changes (a real restart), NOT on a
  // plain reconnect — otherwise a flaky mobile/Tailscale link reloads the whole
  // UI constantly. A network blip reconnects with the same boot id → no reload.
  es.addEventListener("hello", (e) => {
    try {
      const id = JSON.parse(e.data).bootId;
      if (bootId === null) bootId = id;
      else if (id !== bootId && cfg.reload) location.reload();
    } catch {
      /* ignore */
    }
  });
  es.addEventListener("reload", () => {
    if (cfg.reload) location.reload();
  });
  es.addEventListener("fschange", (e) => {
    // Note: we always process changes (so the activity log keeps recording);
    // pausing only suppresses the flash highlights, handled inside flash().
    try {
      const data = JSON.parse(e.data);
      handleFsChanges(data.changes || []);
    } catch {
      /* ignore malformed frame */
    }
  });
  es.addEventListener("watcherror", (e) => {
    let msg = "live directory watch unavailable";
    try { msg = JSON.parse(e.data).message || msg; } catch {}
    const t = $("#watch-toggle");
    t.classList.remove("watch-on");
    t.classList.add("watch-off");
    t.textContent = "✕ watch off";
    t.title = `Watch unavailable: ${msg}`;
  });
}

/** Reflect the live-watch pause state in the topbar toggle. */
function applyWatchToggle() {
  const t = $("#watch-toggle");
  if (t.textContent.includes("watch off")) return; // watcher failed — keep notice
  if (state.watchPaused) {
    t.classList.remove("watch-on");
    t.classList.add("watch-off");
    t.textContent = "❚❚ no flash";
    t.title = "Flashing paused (activity still logged) — click to resume";
  } else {
    t.classList.remove("watch-off");
    t.classList.add("watch-on");
    t.textContent = "● live";
    t.title = "Live watching — click to pause";
  }
}

/** CSS.escape with a fallback for older engines. */
function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
}

/** The tree row element for a root-relative path, if currently rendered. */
function rowFor(path) {
  return document.querySelector(`.tree-row[data-path="${cssEscape(path)}"]`);
}

/** Briefly highlight an element to signal it just changed. */
function flash(el) {
  if (!el) return;
  if (state.watchPaused) return; // paused suppresses flashing (logging continues)
  el.classList.remove("flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1200);
}

/**
 * Reconcile a directory's children in the tree against the latest listing,
 * adding new entries and removing gone ones IN PLACE — existing rows (and any
 * expanded subtrees) are preserved, so there's no wipe-and-rebuild flicker.
 * Only runs if the directory is currently loaded and expanded.
 */
async function refreshDir(dir) {
  const c = document.querySelector(`.tree-children[data-dir="${cssEscape(dir)}"]`);
  if (!c || c.dataset.loaded !== "1" || c.classList.contains("hidden")) return;
  let data;
  try {
    data = await api(`/api/list?path=${encodeURIComponent(dir)}`);
  } catch {
    return;
  }
  // Index existing child nodes by path; drop any non-node placeholders.
  const existing = new Map();
  for (const node of Array.from(c.children)) {
    const row = node.firstElementChild;
    if (row && row.classList && row.classList.contains("tree-row")) {
      existing.set(row.dataset.path, node);
    } else {
      node.remove();
    }
  }
  const want = new Set(data.entries.map((e) => e.path));
  for (const [p, node] of existing) {
    if (!want.has(p)) {
      node.remove();
      existing.delete(p);
    }
  }
  // Place nodes in the server's sorted order, creating only the new ones.
  let i = 0;
  for (const entry of data.entries) {
    let node = existing.get(entry.path);
    if (!node) node = renderNode(entry);
    if (c.children[i] !== node) c.insertBefore(node, c.children[i] || null);
    i++;
  }
  if (data.entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tree-loading";
    empty.textContent = "(empty)";
    c.appendChild(empty);
  }
}

/** Root-relative parent directory of a path ("" for a top-level entry). */
function parentOf(path) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** Flash the nearest rendered ancestor folder of `path` (its parent, etc.). */
function flashAncestorFolder(path) {
  let p = parentOf(path);
  while (p !== "") {
    const r = rowFor(p);
    if (r) {
      flash(r);
      return;
    }
    p = parentOf(p);
  }
}

/** Append a change to the activity log (most recent first; capped). */
const MAX_ACTIVITY = 200;
function addActivity(change) {
  const list = $("#activity-list");
  if (!list) return;
  const li = document.createElement("li");
  li.className = "activity-item";

  const time = document.createElement("span");
  time.className = "act-time";
  time.textContent = new Date().toLocaleTimeString();

  const kind = document.createElement("span");
  kind.className = "act-kind " + (change.kind || "change");
  kind.textContent = change.kind || "change";

  const path = document.createElement("a");
  path.className = "act-path";
  path.textContent = change.path; // textContent — never HTML (untrusted name)
  path.title = change.path;
  path.addEventListener("click", () => openFile(change.path, false));

  li.append(time, kind, path);
  list.prepend(li);
  while (list.children.length > MAX_ACTIVITY) list.removeChild(list.lastChild);
}

/** Apply a coalesced batch of filesystem changes to the UI. */
function handleFsChanges(changes) {
  const openChanged = changes.some((ch) => state.current && ch.path === state.current.path);
  for (const ch of changes) {
    addActivity(ch);
    const row = rowFor(ch.path);
    if (row) {
      flash(row);
    } else {
      // New/removed file: refresh its parent dir if that dir is open, then flash.
      refreshDir(parentOf(ch.path)).then(() => flash(rowFor(ch.path)));
    }
    // Flash the containing folder so activity is visible even when collapsed.
    flashAncestorFolder(ch.path);
  }
  if (openChanged) onOpenFileChanged(state.current.path);
}

/** Show/hide the shared backdrop based on whether any drawer is open. */
function syncBackdrop() {
  const open =
    document.body.classList.contains("tree-open") || document.body.classList.contains("log-open");
  $("#backdrop").classList.toggle("hidden", !open);
}

/** Close both slide-out drawers. */
function closeDrawers() {
  document.body.classList.remove("tree-open", "log-open");
  $("#nav-toggle").setAttribute("aria-expanded", "false");
  $("#log-toggle").setAttribute("aria-expanded", "false");
  syncBackdrop();
}

/** The file currently being viewed changed on disk. */
let openRefreshTimer = null;
function onOpenFileChanged(path) {
  // Don't touch an in-progress edit or a revealed (raw-secret) view — just hint.
  if (state.editing || (state.current && state.current.revealed)) {
    const b = $("#banner");
    b.className = "banner";
    b.textContent = "↻ This file changed on disk. Reopen it to see the latest version.";
    b.classList.remove("hidden");
    return;
  }
  // Debounce: a file being actively written fires many events; refresh once it
  // settles, and update ONLY the viewer content (not the whole page/toolbar).
  if (openRefreshTimer) clearTimeout(openRefreshTimer);
  openRefreshTimer = setTimeout(() => refreshOpenContent(path), 400);
}

/** Re-fetch the open file and swap only the viewer body, preserving scroll. */
async function refreshOpenContent(path) {
  if (!state.current || state.current.path !== path || state.editing) return;
  let data;
  try {
    data = await api(`/api/file?path=${encodeURIComponent(path)}`);
  } catch {
    return; // file vanished or unreadable — leave the current view as-is
  }
  if (!state.current || state.current.path !== path || state.editing) return;
  const viewer = $("#viewer");
  const top = viewer.scrollTop;
  state.current = data;
  renderToolbar(data);
  renderBanner(data);
  renderContent(data);
  viewer.scrollTop = top; // keep the reader where they were
}

// ---------------------------------------------------------------------------
// Confirm modal
// ---------------------------------------------------------------------------

let confirmCb = null;
function showConfirm(title, msg, onOk) {
  $("#confirm-title").textContent = title;
  $("#confirm-msg").textContent = msg;
  confirmCb = onOk;
  $("#confirm").classList.remove("hidden");
}
function hideConfirm() {
  $("#confirm").classList.add("hidden");
  confirmCb = null;
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

async function init() {
  try {
    const cfg = await api("/api/config");
    state.allowWrite = cfg.allowWrite;
    $("#root-path").textContent = cfg.root;
    const badge = $("#mode-badge");
    badge.textContent = cfg.allowWrite ? "read/write" : "read-only";
    badge.classList.add(cfg.allowWrite ? "rw" : "ro");
    setupEvents(cfg);
  } catch (e) {
    $("#root-path").textContent = `error: ${e.message}`;
  }
  // Restore line-wrap preference (wrap is the default).
  if (localStorage.getItem("nowrap") === "1") document.body.classList.add("nowrap");

  // Restore live-watch pause preference.
  state.watchPaused = localStorage.getItem("watchPaused") === "1";
  applyWatchToggle();

  await buildTree();

  // Slide-out drawers: file tree (right) and activity log (left). One at a time.
  $("#nav-toggle").addEventListener("click", () => {
    const open = document.body.classList.toggle("tree-open");
    document.body.classList.remove("log-open");
    $("#nav-toggle").setAttribute("aria-expanded", String(open));
    $("#log-toggle").setAttribute("aria-expanded", "false");
    syncBackdrop();
  });
  $("#log-toggle").addEventListener("click", () => {
    const open = document.body.classList.toggle("log-open");
    document.body.classList.remove("tree-open");
    $("#log-toggle").setAttribute("aria-expanded", String(open));
    $("#nav-toggle").setAttribute("aria-expanded", "false");
    syncBackdrop();
  });
  $("#backdrop").addEventListener("click", closeDrawers);
  $("#activity-clear").addEventListener("click", () => {
    $("#activity-list").innerHTML = "";
  });

  // Line-wrap toggle.
  $("#btn-wrap").addEventListener("click", () => {
    const nowrap = document.body.classList.toggle("nowrap");
    localStorage.setItem("nowrap", nowrap ? "1" : "0");
  });

  // Live-watch pause/resume toggle.
  $("#watch-toggle").addEventListener("click", () => {
    state.watchPaused = !state.watchPaused;
    localStorage.setItem("watchPaused", state.watchPaused ? "1" : "0");
    applyWatchToggle();
  });

  $("#btn-reveal").addEventListener("click", () => {
    if (state.current) {
      showConfirm(
        "Reveal secrets?",
        `Show the raw, un-redacted contents of “${state.current.path}”? Real credentials may be displayed.`,
        () => { hideConfirm(); openFile(state.current.path, true); },
      );
    }
  });
  $("#btn-edit").addEventListener("click", startEdit);
  $("#btn-cancel").addEventListener("click", cancelEdit);
  $("#btn-save").addEventListener("click", saveEdit);
  $("#confirm-cancel").addEventListener("click", hideConfirm);
  $("#confirm-ok").addEventListener("click", () => {
    const cb = confirmCb;
    hideConfirm();
    if (cb) cb();
  });
}

init();
