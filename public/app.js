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
  // When true, show friendly project-derived names; when false, raw UUIDs / full
  // paths. Applied across the graph, Projects, Usage, and the session viewer.
  friendlyNames: true,
  lastProjects: /** @type {null | Array} */ (null), // cache for re-render on toggle
  lastUsage: /** @type {null | object} */ (null),
};

// ---------------------------------------------------------------------------
// Display-name mode: friendly project-derived names vs raw UUIDs / paths.
// ---------------------------------------------------------------------------

/**
 * Derive a friendly project name from a decoded cwd or an encoded project dir,
 * dropping directory-path identifiers (home, username, the long prefix) and
 * keeping the last 1–2 path segments. Splits on both real separators and the
 * encoded "-" so it works for either input form.
 */
function friendlyProjectName(cwdOrEncoded) {
  if (!cwdOrEncoded) return "(unknown)";
  const segs = String(cwdOrEncoded).split(/[/\\-]+/).filter(Boolean);
  if (segs.length === 0) return String(cwdOrEncoded);
  return segs.slice(-2).join("-");
}

/** Update the Views-menu "Names" toggle item to reflect the current mode. */
function updateNamesToggle() {
  const el = document.getElementById("names-toggle");
  if (!el) return;
  el.setAttribute("aria-checked", String(state.friendlyNames));
  const lbl = el.querySelector(".names-toggle-label");
  if (lbl) lbl.textContent = state.friendlyNames ? "Names: Friendly" : "Names: UUID";
}

/** Set the name-mode, persist it, sync both toggles, and re-render open views. */
function setFriendlyNames(value) {
  state.friendlyNames = !!value;
  localStorage.setItem("friendlyNames", state.friendlyNames ? "1" : "0");
  updateNamesToggle();
  const cb = /** @type {HTMLInputElement|null} */ (document.getElementById("graph-friendly"));
  if (cb) cb.checked = state.friendlyNames;
  applyNameMode();
}

/** Re-render whatever name-bearing views are currently visible after a toggle. */
function applyNameMode() {
  if (!$("#graph-overlay").classList.contains("hidden")) scheduleGraphDraw();
  if (state.lastProjects && document.body.classList.contains("projects-open")) {
    renderProjects(state.lastProjects, $("#projects-body"));
  }
  if (state.lastUsage && !$("#usage-overlay").classList.contains("hidden")) {
    $("#usage-body").innerHTML = renderUsageDashboard(state.lastUsage);
  }
  if (state.current && state.current.session && state.current.session.isSession) {
    renderContent(state.current);
  }
}

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

  // Wrap toggle is relevant for any text-ish content (incl. chunked text).
  $("#btn-wrap").classList.toggle("hidden", data.type === "binary");

  // Source xref — always shown when a file is open (server will say if unavailable).
  $("#btn-xref").classList.remove("hidden");

  // Edit only for fully-loaded text files we can write back; not binary, not
  // chunked (we never hold the whole over-cap file in the browser).
  if (state.allowWrite && data.type !== "binary" && !data.chunked) {
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
    viewer.appendChild(renderBinaryViewer(data));
    return;
  }
  if (data.chunked) {
    // Over-cap text/JSONL: load the body in pages via /api/file-lines.
    viewer.appendChild(renderChunked(data));
    return;
  }
  if (data.type === "jsonl") {
    // Use the rich session timeline for Claude Code transcript files.
    if (data.session && data.session.isSession) {
      viewer.appendChild(renderSessionView(data));
    } else {
      viewer.appendChild(renderJsonl(data.content));
    }
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

/** Render a binary file: inline image, embedded PDF, or a download affordance. */
function renderBinaryViewer(data) {
  const wrap = document.createElement("div");
  wrap.className = "binary-view";
  const rawUrl = `/api/raw?path=${encodeURIComponent(data.path)}`;

  // Toolbar: note + open/download links.
  const bar = document.createElement("div");
  bar.className = "binary-bar";
  const meta = document.createElement("span");
  meta.className = "file-meta";
  meta.textContent = data.note || "Binary file.";
  bar.appendChild(meta);
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  bar.appendChild(spacer);
  if (data.viewer === "image" || data.viewer === "pdf") {
    const open = document.createElement("a");
    open.className = "btn";
    open.textContent = "↗ Open";
    open.href = rawUrl;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    bar.appendChild(open);
  }
  const dl = document.createElement("a");
  dl.className = "btn";
  dl.textContent = "⬇ Download";
  dl.href = `${rawUrl}&download=1`;
  dl.setAttribute("download", "");
  bar.appendChild(dl);
  wrap.appendChild(bar);

  if (data.viewer === "image") {
    const img = document.createElement("img");
    img.className = "binary-image";
    img.src = rawUrl;
    img.alt = data.path;
    img.loading = "lazy";
    wrap.appendChild(img);
  } else if (data.viewer === "pdf") {
    const emb = document.createElement("embed");
    emb.className = "binary-pdf";
    emb.type = "application/pdf";
    emb.src = rawUrl;
    wrap.appendChild(emb);
  } else {
    const note = document.createElement("div");
    note.className = "empty";
    note.textContent = "Not previewable — use Download.";
    wrap.appendChild(note);
  }
  return wrap;
}

/** Dispatch an over-cap (chunked) file to the right paged renderer. */
function renderChunked(data) {
  if (data.type === "jsonl" && data.session && data.session.isSession) {
    return renderChunkedSession(data);
  }
  return renderChunkedText(data);
}

/**
 * Shared "status + content + Load more" scaffold for chunked views. The body
 * element is created with `bodyTag`; `onPage(page, body)` appends each page.
 */
function chunkScaffold(data, pageSize, bodyTag, onPage) {
  const status = document.createElement("div");
  status.className = "chunk-status";
  const body = document.createElement(bodyTag);
  const more = document.createElement("button");
  more.className = "btn primary chunk-more";
  more.textContent = "Load more";
  let from = 0;
  let loading = false;
  async function load() {
    if (loading) return;
    loading = true;
    more.disabled = true;
    more.textContent = "Loading…";
    let page;
    try {
      page = await api(
        `/api/file-lines?path=${encodeURIComponent(data.path)}&from=${from}&count=${pageSize}${data.revealed ? "&reveal=1" : ""}`,
      );
    } catch (e) {
      status.textContent = `Error: ${e.message}`;
      loading = false;
      return;
    }
    onPage(page, body);
    from = page.from + page.lines.length;
    const unit = data.type === "jsonl" ? "records" : "lines";
    status.textContent = `Showing ${Math.min(from, page.total).toLocaleString()} of ${page.total.toLocaleString()} ${unit}`;
    more.classList.toggle("hidden", !page.hasMore);
    more.disabled = false;
    more.textContent = "Load more";
    loading = false;
  }
  more.addEventListener("click", load);
  return { status, body, more, load };
}

/** Chunked Claude transcript: header + paged chat bubbles. */
function renderChunkedSession(data) {
  const wrap = document.createElement("div");
  wrap.className = "session-wrap";
  wrap.appendChild(renderSessionHeader(data.session));
  const s = chunkScaffold(data, 200, "div", (page, body) => {
    for (const ln of page.lines) {
      if (ln.text.trim() === "") continue;
      let obj = null;
      try {
        obj = JSON.parse(ln.text);
      } catch {
        /* keep raw */
      }
      body.appendChild(renderSessionBubble(ln.n + 1, obj, ln.text));
    }
  });
  s.body.className = "session-timeline";
  wrap.append(s.status, s.body, s.more);
  s.load();
  return wrap;
}

/** Chunked plain text/JSONL: paged <pre>. */
function renderChunkedText(data) {
  const wrap = document.createElement("div");
  const s = chunkScaffold(data, 1000, "pre", (page, body) => {
    body.appendChild(
      document.createTextNode(page.lines.map((l) => l.text).join("\n") + (page.hasMore ? "\n" : "")),
    );
  });
  s.body.className = "code";
  wrap.append(s.status, s.body, s.more);
  s.load();
  return wrap;
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
  // Hide xref while editing (irrelevant and the overlay would conflict).
  if (on) $("#btn-xref").classList.add("hidden");
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

// Body-class slide-out drawers that share the single #backdrop. Standalone
// overlays (xref, usage, timeline, graph) and the audit drawer manage their own
// show/hide and are intentionally NOT in these lists.
const DRAWER_CLASSES = ["tree-open", "log-open", "settings-open", "history-open", "ext-open", "projects-open"];
const DRAWER_TOGGLES = ["#nav-toggle", "#log-toggle", "#settings-toggle", "#history-toggle", "#ext-toggle", "#projects-toggle"];

/** Show/hide the shared backdrop based on whether any body-class drawer is open. */
function syncBackdrop() {
  const open = DRAWER_CLASSES.some((c) => document.body.classList.contains(c));
  $("#backdrop").classList.toggle("hidden", !open);
}

/** Close every body-class slide-out drawer and reset its toggle's aria state. */
function closeDrawers() {
  document.body.classList.remove(...DRAWER_CLASSES);
  for (const sel of DRAWER_TOGGLES) {
    const el = document.querySelector(sel);
    if (el) el.setAttribute("aria-expanded", "false");
  }
  // Settings panel uses a body class + a hidden element; keep them in sync.
  const sp = document.querySelector("#settings-panel");
  if (sp) sp.classList.add("hidden");
  const ep = document.querySelector("#ext-panel");
  if (ep) ep.setAttribute("aria-hidden", "true");
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
// Session transcript timeline (Claude Code JSONL)
// ---------------------------------------------------------------------------

/**
 * Top-level renderer for a Claude Code session transcript.
 *
 * Builds a header showing the decoded cwd + resume command, then a list of
 * chat bubbles (one per JSONL record), plus a "Raw" toggle that falls back to
 * the generic JSONL view.
 *
 * @param {object} data  FileRead response augmented with a `session` field.
 * @returns {HTMLElement}
 */
function renderSessionView(data) {
  const wrap = document.createElement("div");
  wrap.className = "session-wrap";

  // --- Header ---
  wrap.appendChild(renderSessionHeader(data.session));

  // --- Toggle bar ---
  let showRaw = false;
  const toggleBar = document.createElement("div");
  toggleBar.className = "session-toggle-bar";
  const rawBtn = document.createElement("button");
  rawBtn.className = "btn session-raw-btn";
  rawBtn.textContent = "⇆ Raw";
  rawBtn.title = "Switch to the generic JSONL record view";

  // Container that holds whichever view is active.
  const timelineEl = document.createElement("div");
  timelineEl.className = "session-timeline";
  timelineEl.appendChild(renderSessionTimeline(data.content));

  rawBtn.addEventListener("click", () => {
    showRaw = !showRaw;
    rawBtn.textContent = showRaw ? "⇆ Timeline" : "⇆ Raw";
    rawBtn.title = showRaw ? "Switch to the chat timeline view" : "Switch to the generic JSONL record view";
    timelineEl.innerHTML = "";
    timelineEl.appendChild(showRaw ? renderJsonl(data.content) : renderSessionTimeline(data.content));
  });

  toggleBar.appendChild(rawBtn);
  wrap.appendChild(toggleBar);
  wrap.appendChild(timelineEl);
  return wrap;
}

/**
 * Render the session header: decoded cwd + resumable command with copy affordance.
 *
 * @param {{ isSession: boolean, cwd: string|null, uuid: string|null }} session
 * @returns {HTMLElement}
 */
function renderSessionHeader(session) {
  const header = document.createElement("div");
  header.className = "session-header";

  // Decoded project directory.
  const cwdRow = document.createElement("div");
  cwdRow.className = "session-cwd";
  const cwdLabel = document.createElement("span");
  cwdLabel.className = "session-meta-label";
  cwdLabel.textContent = "Project:";
  const cwdVal = document.createElement("code");
  cwdVal.className = "session-meta-val";
  cwdVal.textContent = state.friendlyNames
    ? friendlyProjectName(session.cwd)
    : (session.cwd ?? "(unknown)");
  cwdVal.title = session.cwd
    ? `${session.cwd} (best-effort decoded; encoding is ambiguous)`
    : "Best-effort decoded project directory (encoding is ambiguous)";
  cwdRow.append(cwdLabel, cwdVal);

  // Resume command.
  const resumeRow = document.createElement("div");
  resumeRow.className = "session-resume";
  const resumeLabel = document.createElement("span");
  resumeLabel.className = "session-meta-label";
  resumeLabel.textContent = "Resume:";
  const resumeCmd = `claude --resume ${escapeHtml(session.uuid ?? "")}`;
  const resumeCode = document.createElement("code");
  resumeCode.className = "session-meta-val session-resume-cmd";
  resumeCode.textContent = `claude --resume ${session.uuid ?? ""}`;
  resumeCode.title = "Click to select all";
  resumeCode.addEventListener("click", () => {
    // Select the text so the user can copy it with Ctrl+C / Cmd+C.
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(resumeCode);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });

  // Copy button.
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn session-copy-btn";
  copyBtn.textContent = "⎘ Copy";
  copyBtn.title = "Copy resume command to clipboard";
  copyBtn.addEventListener("click", () => {
    const cmd = `claude --resume ${session.uuid ?? ""}`;
    navigator.clipboard?.writeText(cmd).then(() => {
      copyBtn.textContent = "✓ Copied";
      setTimeout(() => { copyBtn.textContent = "⎘ Copy"; }, 1500);
    }).catch(() => {
      // Clipboard not available (non-secure context); fall back to select.
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(resumeCode);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  });

  resumeRow.append(resumeLabel, resumeCode, copyBtn);
  header.append(cwdRow, resumeRow);
  return header;
}

/**
 * Parse all JSONL records and render them as a chat timeline.
 *
 * @param {string} text  Raw JSONL content.
 * @returns {HTMLElement}
 */
function renderSessionTimeline(text) {
  const wrap = document.createElement("div");
  wrap.className = "session-messages";

  const lines = text.split("\n");
  let count = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    count++;
    let obj = null;
    try {
      obj = JSON.parse(line);
    } catch {
      /* skip unparseable lines gracefully */
    }
    if (!obj) {
      // Render unparseable lines as a raw entry.
      wrap.appendChild(renderSessionBubble(count, null, raw));
      continue;
    }
    wrap.appendChild(renderSessionBubble(count, obj, raw));
  }
  if (count === 0) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "(no records)";
    wrap.appendChild(e);
  }
  return wrap;
}

/**
 * Classify a JSONL record into a display role for styling.
 *
 * Claude Code session records can be bare messages (`{role, content}`) or
 * wrapped in an outer envelope with a `type` field.  We normalise both.
 *
 * @param {object|null} obj  Parsed record.
 * @returns {string}  One of: user | assistant | tool_use | tool_result |
 *                    system | summary | queue-operation | other | raw
 */
function classifyRecord(obj) {
  if (!obj) return "raw";
  // Outer envelope type (summary, system, queue-operation, …).
  const outerType = typeof obj.type === "string" ? obj.type : null;
  // Inner message role.
  const msg = obj.message ?? null;
  const role = typeof obj.role === "string"
    ? obj.role
    : (msg && typeof msg.role === "string" ? msg.role : null);

  if (outerType === "summary") return "summary";
  if (outerType === "system") return "system";
  if (outerType === "queue-operation") return "queue-operation";
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  // Check for purely tool-use or tool-result messages.
  const content = msg ? (msg.content ?? obj.content) : obj.content;
  if (Array.isArray(content) && content.length > 0) {
    const types = content.map((c) => (c && typeof c.type === "string" ? c.type : ""));
    if (types.every((t) => t === "tool_use")) return "tool_use";
    if (types.every((t) => t === "tool_result")) return "tool_result";
  }
  if (outerType) return outerType;
  return "other";
}

/**
 * Render one session record as a styled chat bubble.
 *
 * @param {number} num        1-based record index.
 * @param {object|null} obj   Parsed record (null = unparseable).
 * @param {string} raw        Raw JSON line (fallback text).
 * @returns {HTMLElement}
 */
function renderSessionBubble(num, obj, raw) {
  const role = classifyRecord(obj);

  const bubble = document.createElement("div");
  bubble.className = `session-bubble session-role-${cssClassFor(role)}`;

  // --- Bubble header (role tag + timestamp + model) ---
  const bubbleHead = document.createElement("div");
  bubbleHead.className = "session-bubble-head";

  const roleTag = document.createElement("span");
  roleTag.className = `session-role-tag session-role-${cssClassFor(role)}`;
  roleTag.textContent = roleLabelFor(role);
  bubbleHead.appendChild(roleTag);

  // Timestamp.
  const ts = extractTimestamp(obj);
  if (ts) {
    const timeEl = document.createElement("span");
    timeEl.className = "session-ts";
    timeEl.textContent = fmtTime(ts);
    bubbleHead.appendChild(timeEl);
  }

  // Model (from message.model or top-level model).
  const model = extractModel(obj);
  if (model) {
    const modelEl = document.createElement("span");
    modelEl.className = "session-model";
    modelEl.textContent = model;
    bubbleHead.appendChild(modelEl);
  }

  // Token usage (input / output / cache).
  const usage = extractUsage(obj);
  if (usage) {
    const usageEl = document.createElement("span");
    usageEl.className = "session-usage";
    usageEl.textContent = fmtUsage(usage);
    usageEl.title = fmtUsageDetail(usage);
    bubbleHead.appendChild(usageEl);
  }

  // Record number (small, dimmed, right-aligned).
  const numEl = document.createElement("span");
  numEl.className = "session-rec-num";
  numEl.textContent = `#${num}`;
  bubbleHead.appendChild(numEl);

  bubble.appendChild(bubbleHead);

  // --- Bubble body (content) ---
  const bodyEl = document.createElement("div");
  bodyEl.className = "session-bubble-body";
  bodyEl.appendChild(renderSessionContent(obj, raw, role));
  bubble.appendChild(bodyEl);

  // --- Collapsible raw JSON ---
  const rawToggle = document.createElement("button");
  rawToggle.className = "session-raw-toggle";
  rawToggle.textContent = "{ }";
  rawToggle.title = "Show raw JSON for this record";
  const rawBody = document.createElement("div");
  rawBody.className = "session-raw-body hidden";
  const rawPre = document.createElement("pre");
  rawPre.className = "code";
  rawPre.textContent = obj ? JSON.stringify(obj, null, 2) : raw;
  rawBody.appendChild(rawPre);
  rawToggle.addEventListener("click", () => {
    const open = rawBody.classList.toggle("hidden");
    rawToggle.textContent = open ? "{ }" : "{ … }";
  });
  bubble.appendChild(rawToggle);
  bubble.appendChild(rawBody);

  return bubble;
}

/**
 * Render the human-readable content of a record.
 *
 * Handles the content field as a string, an array of blocks, or missing.
 *
 * @param {object|null} obj
 * @param {string} raw
 * @param {string} role
 * @returns {HTMLElement}
 */
function renderSessionContent(obj, raw, role) {
  const frag = document.createElement("div");
  frag.className = "session-content";

  if (!obj) {
    const p = document.createElement("p");
    p.className = "session-raw-text";
    p.textContent = raw.slice(0, 500);
    frag.appendChild(p);
    return frag;
  }

  // Special treatment for summary records.
  if (role === "summary") {
    const summary = obj.summary ?? obj.text ?? "";
    if (typeof summary === "string" && summary) {
      const p = document.createElement("p");
      p.className = "session-summary-text";
      p.textContent = summary;
      frag.appendChild(p);
      return frag;
    }
  }

  // Extract the content array/string from the record.
  const msg = obj.message ?? null;
  let content = msg ? (msg.content ?? obj.content) : obj.content;

  // Some records have content at the top level only.
  if (content === undefined) content = obj.content;

  if (typeof content === "string") {
    appendTextBlock(frag, content);
    return frag;
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      switch (block.type) {
        case "text":
          appendTextBlock(frag, String(block.text ?? ""));
          break;
        case "tool_use":
          frag.appendChild(renderToolUseBlock(block));
          break;
        case "tool_result":
          frag.appendChild(renderToolResultBlock(block));
          break;
        default: {
          // Unknown block type: show a short summary.
          const misc = document.createElement("p");
          misc.className = "session-misc-block";
          misc.textContent = `[${escapeHtml(String(block.type ?? "?"))} block]`;
          frag.appendChild(misc);
        }
      }
    }
    if (frag.children.length === 0) {
      const p = document.createElement("p");
      p.className = "session-raw-text";
      p.textContent = "(empty content)";
      frag.appendChild(p);
    }
    return frag;
  }

  // Fallback: show a short preview from previewOf.
  const p = document.createElement("p");
  p.className = "session-raw-text";
  p.textContent = previewOf(obj, raw);
  frag.appendChild(p);
  return frag;
}

/**
 * Append a text-block paragraph (or preformatted block if it looks like code).
 *
 * @param {HTMLElement} parent
 * @param {string} text
 */
function appendTextBlock(parent, text) {
  if (!text) return;
  // Long text may contain embedded code fences; split on them for readability.
  // We render each ``` block as <pre><code>.
  const segments = text.split(/(```[^\n]*\n[\s\S]*?```)/);
  for (const seg of segments) {
    if (!seg) continue;
    const fenceMatch = seg.match(/^```([^\n]*)\n([\s\S]*?)```$/);
    if (fenceMatch) {
      const pre = document.createElement("pre");
      pre.className = "code session-code-block";
      pre.textContent = (fenceMatch[2] ?? "").replace(/\n$/, "");
      parent.appendChild(pre);
    } else {
      const p = document.createElement("p");
      p.className = "session-text-block";
      p.textContent = seg;
      parent.appendChild(p);
    }
  }
}

/**
 * Render a `tool_use` content block as a compact summary.
 *
 * @param {object} block
 * @returns {HTMLElement}
 */
function renderToolUseBlock(block) {
  const el = document.createElement("div");
  el.className = "session-tool-use";

  const label = document.createElement("span");
  label.className = "session-tool-label";
  label.textContent = `🛠 ${block.name ?? "tool"}`;

  el.appendChild(label);

  // Render input as a short inline summary.
  const input = block.input;
  if (input && typeof input === "object") {
    const summary = shortInputSummary(input);
    if (summary) {
      const inputEl = document.createElement("code");
      inputEl.className = "session-tool-input";
      inputEl.textContent = summary;
      el.appendChild(inputEl);
    }
  }

  return el;
}

/**
 * Render a `tool_result` content block as a compact preview.
 *
 * @param {object} block
 * @returns {HTMLElement}
 */
function renderToolResultBlock(block) {
  const el = document.createElement("div");
  el.className = "session-tool-result";

  const label = document.createElement("span");
  label.className = "session-tool-result-label";
  label.textContent = "↩ result";
  el.appendChild(label);

  let resultText = "";
  if (typeof block.content === "string") {
    resultText = block.content;
  } else if (Array.isArray(block.content)) {
    resultText = block.content
      .map((c) => (typeof c === "string" ? c : (c && c.text ? String(c.text) : "")))
      .join(" ");
  }
  if (resultText) {
    const prev = document.createElement("code");
    prev.className = "session-tool-result-preview";
    prev.textContent = resultText.slice(0, 300) + (resultText.length > 300 ? "…" : "");
    el.appendChild(prev);
  }

  return el;
}

/**
 * Produce a short string summary of a tool input object (for the bubble header).
 *
 * @param {object} input
 * @returns {string}
 */
function shortInputSummary(input) {
  // Show the first string value or first key-value pair.
  const entries = Object.entries(input);
  if (entries.length === 0) return "";
  // Prefer a "command", "path", "query", or "content" key.
  const preferred = ["command", "path", "query", "content", "code", "input"];
  for (const key of preferred) {
    if (typeof input[key] === "string") {
      const val = input[key].slice(0, 80);
      return val.length < input[key].length ? val + "…" : val;
    }
  }
  // Fall back to first string value.
  for (const [, v] of entries) {
    if (typeof v === "string") return v.slice(0, 80) + (v.length > 80 ? "…" : "");
  }
  // Last resort: JSON snippet.
  const s = JSON.stringify(input);
  return s.slice(0, 80) + (s.length > 80 ? "…" : "");
}

/**
 * Extract a Unix-ms or ISO timestamp from a record.
 *
 * @param {object|null} obj
 * @returns {number|null}
 */
function extractTimestamp(obj) {
  if (!obj) return null;
  const raw = obj.ts ?? obj.timestamp ?? (obj.message && (obj.message.ts ?? obj.message.timestamp));
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const n = Date.parse(raw);
    if (!isNaN(n)) return n;
  }
  return null;
}

/**
 * Extract the model identifier from a record.
 *
 * @param {object|null} obj
 * @returns {string|null}
 */
function extractModel(obj) {
  if (!obj) return null;
  const m = obj.model ?? (obj.message && obj.message.model);
  return typeof m === "string" && m ? m : null;
}

/**
 * Extract token usage from a record.
 *
 * Handles both `obj.usage` and `obj.message.usage`.
 *
 * @param {object|null} obj
 * @returns {object|null}
 */
function extractUsage(obj) {
  if (!obj) return null;
  const u = obj.usage ?? (obj.message && obj.message.usage);
  if (!u || typeof u !== "object") return null;
  const hasTokens =
    typeof u.input_tokens === "number" ||
    typeof u.output_tokens === "number";
  return hasTokens ? u : null;
}

/**
 * Short usage summary string shown inline in the bubble header.
 *
 * @param {object} usage
 * @returns {string}
 */
function fmtUsage(usage) {
  const parts = [];
  if (typeof usage.input_tokens === "number") parts.push(`↓${usage.input_tokens}`);
  if (typeof usage.output_tokens === "number") parts.push(`↑${usage.output_tokens}`);
  return parts.join(" ");
}

/**
 * Detailed usage breakdown for the title tooltip.
 *
 * @param {object} usage
 * @returns {string}
 */
function fmtUsageDetail(usage) {
  const lines = [];
  if (typeof usage.input_tokens === "number") lines.push(`Input: ${usage.input_tokens.toLocaleString()}`);
  if (typeof usage.output_tokens === "number") lines.push(`Output: ${usage.output_tokens.toLocaleString()}`);
  if (typeof usage.cache_read_input_tokens === "number") lines.push(`Cache read: ${usage.cache_read_input_tokens.toLocaleString()}`);
  if (typeof usage.cache_creation_input_tokens === "number") lines.push(`Cache write: ${usage.cache_creation_input_tokens.toLocaleString()}`);
  return lines.join("\n") || "Token usage";
}

/**
 * Map a role/type string to a CSS class suffix (strip characters unsafe in CSS
 * class names, replace remaining non-alphanumeric runs with hyphens).
 *
 * @param {string} role
 * @returns {string}
 */
function cssClassFor(role) {
  return role.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

/**
 * Human-readable label for a role.
 *
 * @param {string} role
 * @returns {string}
 */
function roleLabelFor(role) {
  const MAP = {
    user: "User",
    assistant: "Assistant",
    tool_use: "Tool use",
    tool_result: "Tool result",
    system: "System",
    summary: "Summary",
    "queue-operation": "Queue",
    other: "Other",
    raw: "Raw",
  };
  return MAP[role] ?? role;
}

// ---------------------------------------------------------------------------
// Source cross-reference overlay
// ---------------------------------------------------------------------------

/** Open the xref overlay and populate it for the currently-open file. */
async function openXref() {
  const data = state.current;
  if (!data) return;

  // Derive the basename to search for (e.g. "settings.json" from "settings.json"
  // or "hooks.json" from "rules/hooks.json").
  const basename = data.path.split("/").pop() || data.path;

  const overlay = $("#xref-overlay");
  const body = $("#xref-body");
  overlay.classList.remove("hidden");
  body.innerHTML = '<div class="empty">Searching…</div>';

  // Update the title with the file name being searched.
  const titleEl = /** @type {HTMLElement} */ ($("#xref-title"));
  titleEl.textContent = `🔗 Source xref — ${escapeHtml(basename)}`;
  // Set as text to ensure no XSS from the basename.
  titleEl.textContent = `🔗 Source xref — ${basename}`;

  let result;
  try {
    result = await api(`/api/xref?name=${encodeURIComponent(basename)}`);
  } catch (e) {
    body.innerHTML = `<div class="empty xref-error">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }

  body.innerHTML = "";
  body.appendChild(renderXrefResult(result, basename));
}

/** Render the xref API result into a DOM tree. */
function renderXrefResult(result, basename) {
  const wrap = document.createElement("div");

  if (!result.available) {
    const note = document.createElement("div");
    note.className = "xref-unavailable";
    note.innerHTML =
      `<p>Source cross-reference is not configured.</p>` +
      `<p>Start the server with <code>--source &lt;dir&gt;</code> or set the ` +
      `<code>CLAUDE_SRC</code> environment variable to the Claude Code source ` +
      `repository path.</p>`;
    wrap.appendChild(note);
    return wrap;
  }

  const summary = document.createElement("div");
  summary.className = "xref-summary";
  if (result.totalMatches === 0) {
    summary.textContent = `No occurrences of "${basename}" found in the source tree.`;
  } else {
    summary.textContent =
      `${result.totalMatches} hit${result.totalMatches !== 1 ? "s" : ""} in ` +
      `${result.matches.length} file${result.matches.length !== 1 ? "s" : ""}` +
      (result.truncated ? ` (results capped — showing first ${result.totalMatches})` : "");
  }
  wrap.appendChild(summary);

  if (result.truncated) {
    const warn = document.createElement("div");
    warn.className = "xref-truncated";
    warn.textContent = "⚠ Results were truncated. Try a more specific basename.";
    wrap.appendChild(warn);
  }

  for (const fileResult of result.matches) {
    wrap.appendChild(renderXrefFile(fileResult));
  }
  return wrap;
}

/** Render a single file's xref hits as a collapsible block. */
function renderXrefFile(fileResult) {
  const block = document.createElement("div");
  block.className = "xref-file";

  const header = document.createElement("div");
  header.className = "xref-file-header";

  const badge = document.createElement("span");
  badge.className = "xref-hit-count";
  badge.textContent = String(fileResult.hits.length);

  const name = document.createElement("span");
  name.className = "xref-file-name";
  name.textContent = fileResult.file; // textContent — safe (server-supplied relative path)
  name.title = fileResult.file;

  const arrow = document.createElement("span");
  arrow.className = "xref-arrow";
  arrow.textContent = "▾";

  header.append(arrow, badge, name);

  const hitsEl = document.createElement("div");
  hitsEl.className = "xref-hits";

  for (const hit of fileResult.hits) {
    hitsEl.appendChild(renderXrefHit(hit));
  }

  header.addEventListener("click", () => {
    const collapsed = hitsEl.classList.toggle("hidden");
    arrow.textContent = collapsed ? "▸" : "▾";
  });

  block.append(header, hitsEl);
  return block;
}

/** Render a single line hit. */
function renderXrefHit(hit) {
  const row = document.createElement("div");
  row.className = "xref-hit-row";

  const lineNum = document.createElement("span");
  lineNum.className = "xref-line-num";
  lineNum.textContent = String(hit.line);

  const code = document.createElement("code");
  code.className = "xref-hit-code";
  code.textContent = hit.text; // textContent — safe (source code, not trusted HTML)

  row.append(lineNum, code);
  return row;
}

/** Close the xref overlay. */
function closeXref() {
  $("#xref-overlay").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Settings Explorer panel
// ---------------------------------------------------------------------------

/** Module-level state for the settings panel. */
const settingsState = {
  open: false,
  revealed: false,
};

/** Open the settings panel, fetching fresh data. */
async function openSettingsPanel() {
  closeDrawers();
  settingsState.open = true;
  document.body.classList.add("settings-open");
  const panel = $("#settings-panel");
  panel.classList.remove("hidden");
  syncBackdrop();
  await loadSettingsPanel(settingsState.revealed);
}

/** Close the settings panel. */
function closeSettingsPanel() {
  settingsState.open = false;
  settingsState.revealed = false;
  document.body.classList.remove("settings-open");
  $("#settings-panel").classList.add("hidden");
  // Reset the reveal button label.
  const btn = $("#settings-reveal-btn");
  btn.textContent = "👁 Reveal";
  btn.removeAttribute("disabled");
}

/** Fetch and render the settings panel contents. */
async function loadSettingsPanel(reveal) {
  const body = $("#settings-panel-body");
  body.innerHTML = '<div class="empty">Loading…</div>';
  let data;
  try {
    data = await api(`/api/settings${reveal ? "?reveal=1" : ""}`);
  } catch (e) {
    body.innerHTML = `<div class="empty" style="color:var(--danger)">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  body.innerHTML = "";
  body.appendChild(renderSettingsPanel(data, reveal));
}

/**
 * Build the settings panel DOM from the API response.
 *
 * All untrusted text (keys, values, filenames) is inserted via textContent
 * or escapeHtml — never innerHTML of user-controlled content.
 *
 * @param {object} data   The /api/settings response object.
 * @param {boolean} reveal Whether raw values are shown.
 */
function renderSettingsPanel(data, reveal) {
  const root = document.createDocumentFragment();

  // --- Redaction notice / reveal confirmation banner -----------------------
  if (!reveal) {
    const notice = document.createElement("div");
    notice.className = "banner";
    notice.style.marginBottom = "12px";
    notice.textContent = "Secret values are redacted. Click 👁 Reveal to show raw values (requires confirmation).";
    root.appendChild(notice);
  } else {
    const notice = document.createElement("div");
    notice.className = "banner danger";
    notice.style.marginBottom = "12px";
    notice.textContent = "⚠ Showing RAW settings — secret values may be visible.";
    root.appendChild(notice);
  }

  // --- Unknown keys badge strip --------------------------------------------
  if (data.unknownKeys && data.unknownKeys.length > 0) {
    const section = document.createElement("div");
    section.className = "settings-section";
    const h = document.createElement("div");
    h.className = "settings-section-title";
    h.textContent = `⚠ Unknown / custom keys (${data.unknownKeys.length})`;
    h.title = "These top-level keys are not in the curated known-keys list — they may be custom settings or undocumented options.";
    section.appendChild(h);
    const badges = document.createElement("div");
    badges.className = "settings-unknown-badges";
    for (const key of data.unknownKeys) {
      const b = document.createElement("span");
      b.className = "settings-unknown-badge";
      b.textContent = key; // textContent — key is untrusted input
      badges.appendChild(b);
    }
    section.appendChild(badges);
    root.appendChild(section);
  }

  // --- Effective merged settings -------------------------------------------
  {
    const section = document.createElement("div");
    section.className = "settings-section";
    const h = document.createElement("div");
    h.className = "settings-section-title";
    h.textContent = "Effective settings (merged)";
    section.appendChild(h);
    const pre = document.createElement("pre");
    pre.className = "code settings-json";
    try {
      pre.textContent = JSON.stringify(data.effective, null, 2);
    } catch {
      pre.textContent = String(data.effective);
    }
    section.appendChild(pre);
    root.appendChild(section);
  }

  // --- Per-layer breakdown --------------------------------------------------
  if (data.layers && data.layers.length > 0) {
    const section = document.createElement("div");
    section.className = "settings-section";
    const h = document.createElement("div");
    h.className = "settings-section-title";
    h.textContent = `Layers (${data.layers.length} file${data.layers.length !== 1 ? "s" : ""} found)`;
    section.appendChild(h);

    for (const layer of data.layers) {
      section.appendChild(renderSettingsLayer(layer));
    }
    root.appendChild(section);
  }

  // --- .bak diff -----------------------------------------------------------
  if (data.bakDiff) {
    root.appendChild(renderBakDiff(data.bakDiff));
  } else {
    const section = document.createElement("div");
    section.className = "settings-section";
    const h = document.createElement("div");
    h.className = "settings-section-title";
    h.textContent = "Backup diff";
    section.appendChild(h);
    const msg = document.createElement("div");
    msg.className = "settings-diff-empty";
    msg.textContent = "No backup file found for settings.json.";
    section.appendChild(msg);
    root.appendChild(section);
  }

  return root;
}

/**
 * Render a single settings layer (file) in the layer breakdown.
 *
 * @param {object} layer A SettingsLayer object from the API.
 */
function renderSettingsLayer(layer) {
  const el = document.createElement("div");
  el.className = "settings-layer";

  const head = document.createElement("div");
  head.className = "settings-layer-head";

  const fname = document.createElement("span");
  fname.className = "settings-layer-file";
  fname.textContent = layer.file; // textContent — path is untrusted

  const badge = document.createElement("span");
  badge.className = "settings-layer-badge";
  if (layer.isBak) {
    badge.textContent = "bak";
    badge.classList.add("bak");
  } else if (layer.file.includes(".local.")) {
    badge.textContent = "local override";
    badge.classList.add("local");
  } else {
    badge.textContent = "base";
    badge.classList.add("base");
  }

  head.append(fname, badge);
  el.appendChild(head);

  if (layer.parseError) {
    const err = document.createElement("div");
    err.className = "settings-layer-error";
    err.textContent = `Parse error: ${layer.parseError}`; // textContent
    el.appendChild(err);
  } else if (layer.parsed !== null) {
    const pre = document.createElement("pre");
    pre.className = "code settings-json";
    try {
      pre.textContent = JSON.stringify(layer.parsed, null, 2);
    } catch {
      pre.textContent = String(layer.parsed);
    }
    el.appendChild(pre);
  }

  return el;
}

/**
 * Render the .bak diff section (added / removed / changed), color-coded.
 *
 * @param {object} diff  The bakDiff object from the API response.
 */
function renderBakDiff(diff) {
  const section = document.createElement("div");
  section.className = "settings-section";

  const h = document.createElement("div");
  h.className = "settings-section-title";
  h.textContent = "Backup diff";
  section.appendChild(h);

  const subtitle = document.createElement("div");
  subtitle.className = "settings-diff-subtitle";
  subtitle.textContent = `Comparing current settings.json ← `;
  const bakSpan = document.createElement("span");
  bakSpan.className = "settings-diff-bakfile";
  bakSpan.textContent = diff.bakFile; // textContent
  subtitle.appendChild(bakSpan);
  section.appendChild(subtitle);

  const total = diff.added.length + diff.removed.length + diff.changed.length;
  if (total === 0) {
    const msg = document.createElement("div");
    msg.className = "settings-diff-empty";
    msg.textContent = "No differences between current settings.json and backup.";
    section.appendChild(msg);
    return section;
  }

  const table = document.createElement("div");
  table.className = "settings-diff-table";

  // Added keys
  for (const key of diff.added) {
    table.appendChild(makeDiffRow("added", key, null, null));
  }
  // Removed keys
  for (const key of diff.removed) {
    table.appendChild(makeDiffRow("removed", key, null, null));
  }
  // Changed keys
  for (const entry of diff.changed) {
    table.appendChild(makeDiffRow("changed", entry.key, entry.oldValue, entry.newValue));
  }

  section.appendChild(table);
  return section;
}

/**
 * Build one row of the diff table.
 *
 * @param {"added"|"removed"|"changed"} kind
 * @param {string} key
 * @param {unknown} oldVal
 * @param {unknown} newVal
 */
function makeDiffRow(kind, key, oldVal, newVal) {
  const row = document.createElement("div");
  row.className = `settings-diff-row settings-diff-${kind}`;

  const kindBadge = document.createElement("span");
  kindBadge.className = "settings-diff-kind";
  kindBadge.textContent = kind;

  const keyEl = document.createElement("span");
  keyEl.className = "settings-diff-key";
  keyEl.textContent = key; // textContent

  row.append(kindBadge, keyEl);

  if (kind === "changed") {
    const arrow = document.createElement("span");
    arrow.className = "settings-diff-arrow";
    arrow.textContent = "→";

    const oldEl = document.createElement("span");
    oldEl.className = "settings-diff-old";
    oldEl.textContent = serializeValue(oldVal); // textContent

    const newEl = document.createElement("span");
    newEl.className = "settings-diff-new";
    newEl.textContent = serializeValue(newVal); // textContent

    row.append(oldEl, arrow, newEl);
  } else if (kind === "added") {
    // Show the value that was added (it's in newVal for added, but the API
    // doesn't send it — just label the key).
    const note = document.createElement("span");
    note.className = "settings-diff-note";
    note.textContent = "(added)";
    row.appendChild(note);
  } else {
    const note = document.createElement("span");
    note.className = "settings-diff-note";
    note.textContent = "(removed)";
    row.appendChild(note);
  }

  return row;
}

/** Format an arbitrary value for display in the diff table. */
function serializeValue(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return `"${v}"`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// History panel — file-history checkpoint diff & restore
// ---------------------------------------------------------------------------

/** Current history view state. */
const historyState = {
  loaded: false,
  snapshots: /** @type {Array} */ ([]),
};

/** Open the history panel and load the snapshot list if not already loaded. */
async function openHistoryPanel() {
  closeDrawers();
  document.body.classList.add("history-open");
  $("#history-toggle").setAttribute("aria-expanded", "true");
  syncBackdrop();

  if (!historyState.loaded) {
    await loadHistoryList();
  }
}

/** Fetch the snapshot list and render it. */
async function loadHistoryList() {
  const listArea = $("#history-list-area");
  const entryArea = $("#history-entry-area");
  listArea.innerHTML = '<div class="history-loading">Loading snapshots…</div>';
  entryArea.classList.add("hidden");
  listArea.classList.remove("hidden");

  let snapshots;
  try {
    snapshots = await api("/api/history/list");
    historyState.snapshots = snapshots;
    historyState.loaded = true;
  } catch (e) {
    listArea.innerHTML = `<div class="history-empty">Error loading history: ${escapeHtml(e.message)}</div>`;
    return;
  }

  listArea.innerHTML = "";
  if (!snapshots || snapshots.length === 0) {
    listArea.innerHTML = '<div class="history-empty">No file-history snapshots found under this root.</div>';
    return;
  }

  for (const snap of snapshots) {
    listArea.appendChild(renderSnapshotItem(snap));
  }
}

/**
 * Render one snapshot item in the list.
 * @param {object} snap  HistorySnapshot from /api/history/list
 */
function renderSnapshotItem(snap) {
  const item = document.createElement("div");
  item.className = "history-snapshot-item";
  item.title = `Session: ${snap.sessionId}`;

  const pathEl = document.createElement("div");
  pathEl.className = "history-snapshot-path";
  pathEl.textContent = snap.targetPath; // textContent — untrusted path

  const meta = document.createElement("div");
  meta.className = "history-snapshot-meta";

  const timeEl = document.createElement("span");
  timeEl.textContent = fmtTime(Date.parse(snap.timestamp) || snap.timestamp);

  const vEl = document.createElement("span");
  vEl.className = "v";
  vEl.textContent = `v${snap.version}`;

  meta.append(timeEl, vEl);

  if (!snap.hasContent) {
    const noContent = document.createElement("span");
    noContent.textContent = "metadata only";
    noContent.style.color = "var(--text-dim)";
    meta.appendChild(noContent);
  }
  if (snap.sensitive) {
    const sensEl = document.createElement("span");
    sensEl.className = "sens-badge";
    sensEl.textContent = "🔒 sensitive";
    meta.appendChild(sensEl);
  }

  item.append(pathEl, meta);
  item.addEventListener("click", () => loadHistoryEntry(snap.id));
  return item;
}

/**
 * Fetch and render a history entry (diff view).
 * @param {string} id  Snapshot ID
 */
async function loadHistoryEntry(id) {
  const listArea = $("#history-list-area");
  const entryArea = $("#history-entry-area");
  const diffEl = $("#history-diff");
  const titleEl = $("#history-entry-title");
  const restoreBtn = $("#history-restore");

  listArea.classList.add("hidden");
  entryArea.classList.remove("hidden");
  diffEl.innerHTML = '<div class="history-loading">Loading diff…</div>';
  titleEl.textContent = "";
  restoreBtn.classList.add("hidden");

  let entry;
  try {
    entry = await api(`/api/history/entry?id=${encodeURIComponent(id)}`);
  } catch (e) {
    diffEl.innerHTML = `<div class="diff-no-content">Error loading snapshot: ${escapeHtml(e.message)}</div>`;
    return;
  }

  titleEl.textContent = `${entry.targetPath}  v${entry.version}  ${fmtTime(Date.parse(entry.timestamp) || entry.timestamp)}`;

  // Restore button: only shown when the server allows writes and the entry has content.
  if (state.allowWrite && entry.canRestore) {
    restoreBtn.classList.remove("hidden");
    // Remove any previous listener by cloning.
    const fresh = restoreBtn.cloneNode(true);
    restoreBtn.replaceWith(fresh);
    fresh.addEventListener("click", () => confirmRestore(entry));
  }

  renderDiff(diffEl, entry);
}

/**
 * Render the diff section for a history entry.
 * @param {HTMLElement} container
 * @param {object} entry  HistoryEntry from /api/history/entry
 */
function renderDiff(container, entry) {
  container.innerHTML = "";

  if (entry.redacted) {
    const notice = document.createElement("div");
    notice.className = "diff-redact-notice";
    notice.textContent = "⚠ Secrets are redacted in this view. The diff shows masked values.";
    container.appendChild(notice);
  }

  if (entry.snapshotContent === null) {
    const msg = document.createElement("div");
    msg.className = "diff-no-content";
    msg.textContent =
      "This snapshot (v1) has no stored content file — it records that the file " +
      "was being tracked from version 1, but no before-state backup exists.";
    container.appendChild(msg);
    return;
  }

  if (entry.diff.length === 0 && entry.snapshotContent !== null && entry.currentContent !== null) {
    // Same content — show a positive "no changes" message.
    const msg = document.createElement("div");
    msg.className = "diff-no-changes";
    msg.textContent = "✓ No changes between this snapshot and the current file.";
    container.appendChild(msg);
    return;
  }

  if (entry.diff.length === 0) {
    // Snapshot exists but we couldn't read the current file.
    const headA = document.createElement("div");
    headA.className = "diff-heading";
    headA.textContent = "Snapshot content (current file not available for comparison):";
    container.appendChild(headA);
    const pre = document.createElement("pre");
    pre.className = "code";
    pre.style.padding = "8px 12px";
    pre.style.fontSize = "12px";
    pre.textContent = entry.snapshotContent;
    container.appendChild(pre);
    return;
  }

  // Show a "before → current" heading.
  const heading = document.createElement("div");
  heading.className = "diff-heading";
  heading.textContent = "Snapshot (before) → Current (after)";
  container.appendChild(heading);

  container.appendChild(buildDiffTable(entry.diff));
}

/**
 * Build an HTML table for the diff lines.
 * @param {Array<{type:string, text:string, aLine?:number, bLine?:number}>} lines
 */
function buildDiffTable(lines) {
  const table = document.createElement("table");
  table.className = "diff-table";
  for (const line of lines) {
    const tr = document.createElement("tr");
    tr.className = `diff-${line.type}`; // diff-ctx | diff-add | diff-del

    // Left gutter: "before" line number
    const gutA = document.createElement("td");
    gutA.className = "diff-gutter";
    gutA.textContent = line.aLine != null ? String(line.aLine) : "";

    // Right gutter: "after" line number
    const gutB = document.createElement("td");
    gutB.className = "diff-gutter";
    gutB.textContent = line.bLine != null ? String(line.bLine) : "";

    // Change sign
    const sign = document.createElement("td");
    sign.className = "diff-sign";
    sign.textContent = line.type === "add" ? "+" : line.type === "del" ? "−" : " ";

    // Content cell — always set as textContent (never innerHTML) to prevent injection.
    const content = document.createElement("td");
    content.textContent = line.text;

    tr.append(gutA, gutB, sign, content);
    table.appendChild(tr);
  }
  return table;
}

/**
 * Prompt the user to confirm a restore, then call the restore endpoint.
 * @param {object} entry  HistoryEntry
 */
function confirmRestore(entry) {
  showConfirm(
    "Restore snapshot?",
    `Restore "${entry.targetPath}" to the state from ${fmtTime(Date.parse(entry.timestamp) || entry.timestamp)} (v${entry.version})? ` +
      "The current file will be backed up to .analyzer-backups/ first.",
    async () => {
      hideConfirm();
      try {
        const result = await apiPost("/api/history/restore", { id: entry.id });
        const banner = $("#banner");
        banner.className = "banner ok";
        banner.textContent =
          `Restored ${escapeHtml(result.restoredPath)} (${fmtBytes(result.bytes)}).` +
          (result.backup ? ` Backup: ${escapeHtml(result.backup)}` : "");
        banner.classList.remove("hidden");
        // Show the restored content in the main viewer.
        await openFile(entry.targetPath, false);
      } catch (e) {
        const banner = $("#banner");
        banner.className = "banner danger";
        banner.textContent = `Restore failed: ${escapeHtml(e.message)}`;
        banner.classList.remove("hidden");
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Extensions panel (hooks / agents / skills / commands / MCP)
// ---------------------------------------------------------------------------

/** Cached extensions data (refetched when panel opens). */
let extData = null;
/** Currently active tab name. */
let extActiveTab = "hooks";

/**
 * Open the extensions panel: fetch data from /api/extensions and render the
 * active tab. Closes other drawers first.
 */
async function openExtensions() {
  closeDrawers();
  document.body.classList.add("ext-open");
  $("#ext-toggle").setAttribute("aria-expanded", "true");
  $("#ext-panel").setAttribute("aria-hidden", "false");
  syncBackdrop();

  const content = $("#ext-content");
  content.innerHTML = '<div class="ext-loading">Loading extensions…</div>';

  try {
    extData = await api("/api/extensions");
  } catch (e) {
    content.innerHTML = `<div class="ext-error">Failed to load extensions: ${escapeHtml(e.message)}</div>`;
    return;
  }
  // Update tab badges with counts.
  const counts = extData.counts || {};
  for (const btn of document.querySelectorAll(".ext-tab")) {
    const tab = btn.dataset.tab;
    const n = counts[tab] ?? 0;
    // Strip any existing badge before adding.
    btn.textContent = btn.dataset.label || capitalize(tab);
    if (n > 0) {
      const b = document.createElement("span");
      b.className = "ext-badge";
      b.textContent = String(n);
      btn.appendChild(b);
    }
    // Store the label so we can rebuild on re-render.
    btn.dataset.label = btn.dataset.label || capitalize(tab);
  }
  renderExtTab(extActiveTab);
}

/** Capitalize the first letter of a string. */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Render the named tab panel into #ext-content. */
function renderExtTab(tab) {
  extActiveTab = tab;
  // Mark the active tab button.
  for (const btn of document.querySelectorAll(".ext-tab")) {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  const content = $("#ext-content");
  if (!extData) return;
  switch (tab) {
    case "hooks":    content.innerHTML = renderHooks(extData.hooks || []); break;
    case "agents":   content.innerHTML = renderAgents(extData.agents || []); break;
    case "skills":   content.innerHTML = renderSkills(extData.skills || []); break;
    case "commands": content.innerHTML = renderCommands(extData.commands || []); break;
    case "mcp":      content.innerHTML = renderMcp(extData.mcp || []); break;
    default:         content.innerHTML = "";
  }
  // Wire click-to-open-file links after innerHTML.
  for (const a of content.querySelectorAll("[data-open-file]")) {
    a.addEventListener("click", () => {
      const p = a.getAttribute("data-open-file");
      if (p) openFile(p, false);
    });
  }
}

/** Render the hooks section. */
function renderHooks(hooks) {
  if (!hooks.length) return '<div class="ext-empty">No hooks configured in settings.json.</div>';
  let html = '<ul class="ext-list">';
  for (const h of hooks) {
    html += '<li class="ext-item">';
    html += `<span class="ext-tag hook-event">${escapeHtml(h.event)}</span>`;
    if (h.matcher && h.matcher !== "*") {
      html += ` <span class="ext-tag hook-matcher">${escapeHtml(h.matcher)}</span>`;
    }
    html += `<code class="ext-cmd">${escapeHtml(h.command)}</code>`;
    if (h.redacted) html += ' <span class="ext-tag redacted" title="command was redacted">🔒</span>';
    html += "</li>";
  }
  html += "</ul>";
  return html;
}

/** Render the agents section. */
function renderAgents(agents) {
  if (!agents.length) return '<div class="ext-empty">No agents found in agents/.</div>';
  let html = '<ul class="ext-list">';
  for (const a of agents) {
    html += '<li class="ext-item">';
    html += '<div class="ext-item-head">';
    html += `<a class="ext-name ext-file-link" data-open-file="${escapeHtml(a.file)}" href="#" title="Open ${escapeHtml(a.file)}">${escapeHtml(a.name || a.file)}</a>`;
    if (a.frontmatter && a.frontmatter.color) {
      html += ` <span class="ext-tag" style="background:${escapeHtml(a.frontmatter.color)};color:#fff">${escapeHtml(a.frontmatter.color)}</span>`;
    }
    html += "</div>";
    if (a.description) {
      html += `<div class="ext-desc">${escapeHtml(a.description)}</div>`;
    }
    if (a.frontmatter) {
      const pairs = Object.entries(a.frontmatter)
        .filter(([k]) => k !== "name" && k !== "description" && k !== "color");
      if (pairs.length) {
        html += '<dl class="ext-fm">';
        for (const [k, v] of pairs) {
          const display = Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
          html += `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(display)}</dd>`;
        }
        html += "</dl>";
      }
    }
    if (a.bodyPreview) {
      html += `<div class="ext-preview">${escapeHtml(a.bodyPreview)}</div>`;
    }
    html += "</li>";
  }
  html += "</ul>";
  return html;
}

/** Render the skills section. */
function renderSkills(skills) {
  if (!skills.length) return '<div class="ext-empty">No skills found in skills/.</div>';
  let html = '<ul class="ext-list">';
  for (const s of skills) {
    html += '<li class="ext-item">';
    html += '<div class="ext-item-head">';
    html += `<a class="ext-name ext-file-link" data-open-file="${escapeHtml(s.file)}" href="#" title="Open ${escapeHtml(s.file)}">${escapeHtml(s.name || s.file)}</a>`;
    html += "</div>";
    if (s.description) {
      html += `<div class="ext-desc">${escapeHtml(s.description)}</div>`;
    }
    if (s.frontmatter) {
      const pairs = Object.entries(s.frontmatter)
        .filter(([k]) => k !== "name" && k !== "description");
      if (pairs.length) {
        html += '<dl class="ext-fm">';
        for (const [k, v] of pairs) {
          const display = Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
          html += `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(display)}</dd>`;
        }
        html += "</dl>";
      }
    }
    if (s.bodyPreview) {
      html += `<div class="ext-preview">${escapeHtml(s.bodyPreview)}</div>`;
    }
    html += "</li>";
  }
  html += "</ul>";
  return html;
}

/** Render the commands section. */
function renderCommands(commands) {
  if (!commands.length) return '<div class="ext-empty">No commands found in commands/.</div>';
  let html = '<ul class="ext-list">';
  for (const c of commands) {
    html += '<li class="ext-item">';
    html += '<div class="ext-item-head">';
    html += `<a class="ext-name ext-file-link" data-open-file="${escapeHtml(c.file)}" href="#" title="Open ${escapeHtml(c.file)}">${escapeHtml(c.name || c.file)}</a>`;
    html += "</div>";
    if (c.description) {
      html += `<div class="ext-desc">${escapeHtml(c.description)}</div>`;
    }
    if (c.bodyPreview) {
      html += `<div class="ext-preview">${escapeHtml(c.bodyPreview)}</div>`;
    }
    html += "</li>";
  }
  html += "</ul>";
  return html;
}

/** Render the MCP servers section. */
function renderMcp(servers) {
  if (!servers.length) return '<div class="ext-empty">No MCP servers configured.</div>';
  let html = '<ul class="ext-list">';
  for (const s of servers) {
    html += '<li class="ext-item">';
    html += '<div class="ext-item-head">';
    html += `<span class="ext-name">${escapeHtml(s.name)}</span>`;
    if (s.needsAuth) html += ' <span class="ext-tag mcp-auth" title="This server requires authentication">🔐 auth</span>';
    if (s.disabled) html += ' <span class="ext-tag mcp-disabled">disabled</span>';
    html += "</div>";
    if (s.type) {
      html += `<div class="ext-desc ext-mcp-type">${escapeHtml(s.type)}`;
      if (s.command) html += `: <code>${escapeHtml(s.command)}</code>`;
      if (s.url) html += `: <code>${escapeHtml(s.url)}</code>`;
      html += "</div>";
    }
    if (s.args && s.args.length) {
      html += `<div class="ext-desc">args: <code>${s.args.map(escapeHtml).join(" ")}</code></div>`;
    }
    if (s.source) {
      html += `<div class="ext-desc ext-source">from: ${escapeHtml(s.source)}</div>`;
    }
    html += "</li>";
  }
  html += "</ul>";
  return html;
}

// ---------------------------------------------------------------------------
// Projects panel
// ---------------------------------------------------------------------------

/**
 * Fetch /api/projects and render the projects panel.
 * Called the first time the panel is opened (lazy load).
 */
async function loadProjects() {
  const body = $("#projects-body");
  body.innerHTML = '<div class="projects-loading">Loading…</div>';
  let projects;
  try {
    projects = await api("/api/projects");
  } catch (e) {
    body.innerHTML = `<div class="projects-error">Failed to load projects: ${escapeHtml(e.message)}</div>`;
    return;
  }
  state.lastProjects = projects; // cache so the name-mode toggle can re-render
  renderProjects(projects, body);
}

/**
 * Render the project list into `container`.
 *
 * @param {Array} projects  Array of ProjectEntry objects from /api/projects.
 * @param {HTMLElement} container  Target element to render into.
 */
function renderProjects(projects, container) {
  container.innerHTML = "";

  if (!projects || projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "projects-empty";
    empty.textContent = "No projects found under projects/ in the configured root.";
    container.appendChild(empty);
    return;
  }

  for (const proj of projects) {
    container.appendChild(renderProjectCard(proj));
  }
}

/**
 * Render a single collapsible project card.
 *
 * @param {object} proj  A ProjectEntry from the API.
 * @returns {HTMLElement}
 */
function renderProjectCard(proj) {
  const card = document.createElement("div");
  card.className = "project-card";

  // Header row (click to expand/collapse).
  const header = document.createElement("div");
  header.className = "project-header";
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", "false");

  const twisty = document.createElement("span");
  twisty.className = "project-twisty";
  twisty.textContent = "▸";
  twisty.setAttribute("aria-hidden", "true");

  const cwd = document.createElement("span");
  cwd.className = "project-cwd";
  // Friendly project name vs full decoded cwd, per the global names mode.
  cwd.textContent = state.friendlyNames ? friendlyProjectName(proj.cwd) : proj.cwd;
  cwd.title = proj.cwd; // full path always available on hover
  cwd.dataset.cwd = proj.cwd;

  const badge = document.createElement("span");
  badge.className = `project-badge ${proj.exists ? "exists" : "missing"}`;
  badge.textContent = proj.exists ? "exists" : "missing";
  badge.title = proj.exists
    ? "Working directory exists on disk"
    : "Working directory not found on disk";

  const meta = document.createElement("span");
  meta.className = "project-meta";
  const count = proj.sessionCount === 1 ? "1 session" : `${proj.sessionCount} sessions`;
  const lastUsedStr = proj.lastUsed > 0 ? fmtTime(proj.lastUsed) : "—";
  meta.textContent = `${count} · ${lastUsedStr}`;

  header.append(twisty, cwd, badge, meta);

  // Sessions list (hidden by default).
  const sessions = document.createElement("div");
  sessions.className = "project-sessions";

  if (proj.sessions && proj.sessions.length > 0) {
    for (const sess of proj.sessions) {
      sessions.appendChild(renderSessionRow(sess));
    }
    if (proj.truncated) {
      const note = document.createElement("div");
      note.className = "project-truncated";
      note.textContent = `… and ${proj.sessionCount - proj.sessions.length} more sessions not shown`;
      sessions.appendChild(note);
    }
  } else {
    const empty = document.createElement("div");
    empty.className = "project-truncated";
    empty.textContent = "(no session files)";
    sessions.appendChild(empty);
  }

  // Toggle expand/collapse on click or Enter/Space.
  function toggle() {
    const open = sessions.classList.toggle("open");
    twisty.textContent = open ? "▾" : "▸";
    header.setAttribute("aria-expanded", String(open));
  }
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });

  card.append(header, sessions);
  return card;
}

/**
 * Render a single session row inside an expanded project.
 *
 * @param {object} sess  A SessionEntry from the API.
 * @returns {HTMLElement}
 */
function renderSessionRow(sess) {
  const row = document.createElement("div");
  row.className = "session-row";
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");
  row.title = `Open session ${sess.uuid}`;

  const uuid = document.createElement("span");
  uuid.className = "session-uuid";
  uuid.textContent = sess.uuid; // textContent — safe for untrusted UUID strings

  const meta = document.createElement("span");
  meta.className = "session-meta";
  meta.textContent = `${fmtBytes(sess.size)} · ${fmtTime(sess.mtime)}`;

  row.append(uuid, meta);

  function open() {
    openFile(sess.path, false);
  }
  row.addEventListener("click", open);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  });

  return row;
}

// ---------------------------------------------------------------------------
// Security & Retention Audit panel
// ---------------------------------------------------------------------------

/**
 * Toggle the audit drawer open/closed.  Closes the tree/log drawers so only
 * one overlay is open at a time (consistent with existing drawer pattern).
 */
function toggleAuditDrawer() {
  const drawer = $("#audit-drawer");
  const btn = $("#audit-toggle");
  const open = drawer.classList.toggle("audit-open");
  btn.setAttribute("aria-expanded", String(open));
  if (open) closeDrawers(); // close tree/log drawers
}

/** Close the audit drawer. */
function closeAuditDrawer() {
  $("#audit-drawer").classList.remove("audit-open");
  $("#audit-toggle").setAttribute("aria-expanded", "false");
}

/**
 * Fetch `/api/audit` and render the results into the audit panel.
 * Shows a loading state while the request is in flight.
 */
async function runAudit() {
  const body = $("#audit-body");
  body.innerHTML = '<div class="audit-loading">⏳ Scanning… this may take a few seconds.</div>';

  let data;
  try {
    data = await api("/api/audit");
  } catch (e) {
    body.innerHTML = `<div class="audit-error">Audit failed: ${escapeHtml(e.message)}</div>`;
    return;
  }

  body.innerHTML = "";

  // ---- Meta bar ----
  const meta = document.createElement("div");
  meta.className = "audit-meta";
  meta.innerHTML =
    `<span>${escapeHtml(String(data.fileCount))} files scanned</span>` +
    (data.truncated ? ' <span class="audit-warn">⚠ truncated at 20 000 files</span>' : "") +
    `<span class="audit-dim">${escapeHtml(new Date(data.generatedAt).toLocaleString())}</span>` +
    `<button id="audit-run" class="btn audit-run-btn">↺ Re-run</button>`;
  body.appendChild(meta);
  meta.querySelector("#audit-run")?.addEventListener("click", runAudit);

  // ---- (a) Exposure section ----
  body.appendChild(buildExposureSection(data.exposure));

  // ---- (b) Permissions section ----
  body.appendChild(buildPermissionsSection(data.permissions));

  // ---- (c) Retention section ----
  body.appendChild(buildRetentionSection(data.retention));
}

/**
 * Build the secret-exposure section DOM.
 *
 * @param {Array<{path:string, hitCount:number, sample:string, sensitivePath:boolean}>} entries
 * @returns {HTMLElement}
 */
function buildExposureSection(entries) {
  const sec = document.createElement("section");
  sec.className = "audit-section";

  const h = document.createElement("h3");
  h.className = "audit-section-title";
  const badge = entries.length > 0
    ? `<span class="audit-badge danger">${escapeHtml(String(entries.length))}</span>`
    : `<span class="audit-badge ok">0</span>`;
  h.innerHTML = `🔑 Secret Exposure ${badge}`;
  sec.appendChild(h);

  if (entries.length === 0) {
    const p = document.createElement("p");
    p.className = "audit-none";
    p.textContent = "No secret-shaped content detected.";
    sec.appendChild(p);
    return sec;
  }

  const note = document.createElement("p");
  note.className = "audit-note";
  note.textContent =
    "Files where secret-shaped content was detected (redacted). " +
    "Click a path to view the file (displayed redacted). Advisory only — no values are shown here.";
  sec.appendChild(note);

  const table = document.createElement("table");
  table.className = "audit-table";
  table.innerHTML =
    "<thead><tr>" +
    "<th>Path</th><th>Hits</th><th>Type</th><th>Sample (masked)</th>" +
    "</tr></thead>";
  const tbody = document.createElement("tbody");

  for (const e of entries) {
    const tr = document.createElement("tr");
    tr.className = e.hitCount >= 3 ? "sev-danger" : "sev-warn";

    // Path cell — clickable link that opens the file (stays redacted).
    const tdPath = document.createElement("td");
    const a = document.createElement("a");
    a.className = "audit-file-link";
    a.textContent = e.path;
    a.title = "Open file (redacted view)";
    a.addEventListener("click", () => {
      closeAuditDrawer();
      openFile(e.path, false /* do not reveal */);
    });
    tdPath.appendChild(a);
    tr.appendChild(tdPath);

    // Hit count.
    const tdHits = document.createElement("td");
    tdHits.className = "audit-hits";
    tdHits.textContent = String(e.hitCount);
    tr.appendChild(tdHits);

    // Type badge.
    const tdType = document.createElement("td");
    tdType.innerHTML = e.sensitivePath
      ? '<span class="audit-type-badge sensitive">sensitive path</span>'
      : '<span class="audit-type-badge inline">inline</span>';
    tr.appendChild(tdType);

    // Masked sample — never contains raw values; `escapeHtml` for safety.
    const tdSample = document.createElement("td");
    tdSample.className = "audit-sample";
    tdSample.textContent = e.sample || "—";
    tr.appendChild(tdSample);

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  sec.appendChild(table);
  return sec;
}

/**
 * Build the file-permissions section DOM.
 *
 * @param {Array<{path:string, mode:string, groupOrWorldReadable:boolean}>} entries
 * @returns {HTMLElement}
 */
function buildPermissionsSection(entries) {
  const sec = document.createElement("section");
  sec.className = "audit-section";

  const h = document.createElement("h3");
  h.className = "audit-section-title";
  const badge = entries.length > 0
    ? `<span class="audit-badge warn">${escapeHtml(String(entries.length))}</span>`
    : `<span class="audit-badge ok">0</span>`;
  h.innerHTML = `🔓 Permission Warnings ${badge}`;
  sec.appendChild(h);

  if (entries.length === 0) {
    const p = document.createElement("p");
    p.className = "audit-none";
    p.textContent = "No sensitive files with group/world-readable permissions detected.";
    sec.appendChild(p);
    return sec;
  }

  const note = document.createElement("p");
  note.className = "audit-note";
  note.textContent =
    "Sensitive files that are readable by group or world (mode has g/o bits set). " +
    "Consider tightening to 0600.";
  sec.appendChild(note);

  const table = document.createElement("table");
  table.className = "audit-table";
  table.innerHTML =
    "<thead><tr><th>Path</th><th>Mode</th></tr></thead>";
  const tbody = document.createElement("tbody");

  for (const e of entries) {
    const tr = document.createElement("tr");
    tr.className = "sev-warn";

    const tdPath = document.createElement("td");
    const a = document.createElement("a");
    a.className = "audit-file-link";
    a.textContent = e.path;
    a.title = "Open file (redacted view)";
    a.addEventListener("click", () => {
      closeAuditDrawer();
      openFile(e.path, false);
    });
    tdPath.appendChild(a);
    tr.appendChild(tdPath);

    const tdMode = document.createElement("td");
    tdMode.className = "audit-mode";
    tdMode.textContent = e.mode;
    tr.appendChild(tdMode);

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  sec.appendChild(table);
  return sec;
}

/**
 * Build the retention advisor section DOM.
 *
 * @param {{totalBytes:number, byDir:Array<{dir:string,bytes:number}>, largest:Array<{path:string,bytes:number}>, stale:Array<{path:string,bytes:number,ageDays:number,suggestion:string}>}} retention
 * @returns {HTMLElement}
 */
function buildRetentionSection(retention) {
  const sec = document.createElement("section");
  sec.className = "audit-section";

  const h = document.createElement("h3");
  h.className = "audit-section-title";
  h.textContent = `📦 Retention & Size (${fmtBytes(retention.totalBytes)} total)`;
  sec.appendChild(h);

  // By-directory summary.
  if (retention.byDir.length > 0) {
    const sub = document.createElement("div");
    sub.className = "audit-subsection";

    const subh = document.createElement("h4");
    subh.className = "audit-subsection-title";
    subh.textContent = "By top-level directory";
    sub.appendChild(subh);

    const rows = document.createElement("div");
    rows.className = "audit-dir-grid";
    for (const d of retention.byDir.slice(0, 12)) {
      const label = document.createElement("span");
      label.className = "audit-dir-name";
      label.textContent = d.dir === "" ? "(root)" : d.dir;
      const size = document.createElement("span");
      size.className = "audit-dir-size";
      size.textContent = fmtBytes(d.bytes);
      rows.append(label, size);
    }
    sub.appendChild(rows);
    sec.appendChild(sub);
  }

  // Largest files.
  if (retention.largest.length > 0) {
    const sub = document.createElement("div");
    sub.className = "audit-subsection";

    const subh = document.createElement("h4");
    subh.className = "audit-subsection-title";
    subh.textContent = `Largest files (top ${retention.largest.length})`;
    sub.appendChild(subh);

    const table = document.createElement("table");
    table.className = "audit-table";
    table.innerHTML = "<thead><tr><th>Path</th><th>Size</th></tr></thead>";
    const tbody = document.createElement("tbody");
    for (const f of retention.largest) {
      const tr = document.createElement("tr");
      const tdPath = document.createElement("td");
      const a = document.createElement("a");
      a.className = "audit-file-link";
      a.textContent = f.path;
      a.addEventListener("click", () => {
        closeAuditDrawer();
        openFile(f.path, false);
      });
      tdPath.appendChild(a);
      const tdSize = document.createElement("td");
      tdSize.className = "audit-size";
      tdSize.textContent = fmtBytes(f.bytes);
      tr.append(tdPath, tdSize);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    sub.appendChild(table);
    sec.appendChild(sub);
  }

  // Stale / reclaimable files.
  const sub = document.createElement("div");
  sub.className = "audit-subsection";

  const subh = document.createElement("h4");
  subh.className = "audit-subsection-title";
  const staleBadge = retention.stale.length > 0
    ? `<span class="audit-badge warn">${escapeHtml(String(retention.stale.length))}</span>`
    : `<span class="audit-badge ok">0</span>`;
  subh.innerHTML = `Likely reclaimable ${staleBadge}`;
  sub.appendChild(subh);

  const advisory = document.createElement("p");
  advisory.className = "audit-note";
  advisory.textContent =
    "Advisory only — no files are deleted. Review and clean up manually as appropriate.";
  sub.appendChild(advisory);

  if (retention.stale.length === 0) {
    const p = document.createElement("p");
    p.className = "audit-none";
    p.textContent = "No obviously reclaimable files detected.";
    sub.appendChild(p);
  } else {
    const table = document.createElement("table");
    table.className = "audit-table";
    table.innerHTML =
      "<thead><tr><th>Path</th><th>Size</th><th>Age (days)</th><th>Suggestion</th></tr></thead>";
    const tbody = document.createElement("tbody");
    for (const f of retention.stale) {
      const tr = document.createElement("tr");
      tr.className = "sev-info";

      const tdPath = document.createElement("td");
      const a = document.createElement("a");
      a.className = "audit-file-link";
      a.textContent = f.path;
      a.addEventListener("click", () => {
        closeAuditDrawer();
        openFile(f.path, false);
      });
      tdPath.appendChild(a);
      tr.appendChild(tdPath);

      const tdSize = document.createElement("td");
      tdSize.className = "audit-size";
      tdSize.textContent = fmtBytes(f.bytes);
      tr.appendChild(tdSize);

      const tdAge = document.createElement("td");
      tdAge.className = "audit-age";
      tdAge.textContent = String(f.ageDays);
      tr.appendChild(tdAge);

      const tdSug = document.createElement("td");
      tdSug.className = "audit-suggestion";
      tdSug.textContent = f.suggestion;
      tr.appendChild(tdSug);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    sub.appendChild(table);
  }

  sec.appendChild(sub);
  return sec;
}

// ---------------------------------------------------------------------------
// Usage & cost dashboard
// ---------------------------------------------------------------------------

/**
 * Format a large integer with commas for display (e.g. 1234567 → "1,234,567").
 * @param {number} n
 * @returns {string}
 */
function fmtNum(n) {
  return Number.isFinite(n) ? n.toLocaleString() : "0";
}

/**
 * Format token count in a human-friendly abbreviated form.
 * @param {number} n
 * @returns {string}
 */
function fmtTokens(n) {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Format a USD cost value.
 * @param {number} usd
 * @returns {string}
 */
function fmtCost(usd) {
  if (!Number.isFinite(usd)) return "—";
  if (usd < 0.01) return `<$0.01`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Build an SVG area/line chart for the messages-over-time data.
 * Returns an SVG string (all labels are already HTML-escaped).
 *
 * @param {Array<{date: string, count: number}>} data
 * @param {number} width   Logical SVG width
 * @param {number} height  Logical SVG height
 * @returns {string}
 */
function buildAreaChart(data, width, height) {
  if (data.length === 0) return "";
  const pad = { top: 10, right: 14, bottom: 30, left: 46 };
  const W = width - pad.left - pad.right;
  const H = height - pad.top - pad.bottom;

  const maxCount = Math.max(...data.map((d) => d.count), 1);
  const n = data.length;

  /** @param {number} i @returns {number} */
  const xOf = (i) => (n === 1 ? pad.left + W / 2 : pad.left + (i / (n - 1)) * W);
  /** @param {number} v @returns {number} */
  const yOf = (v) => pad.top + H - (v / maxCount) * H;

  // Area fill path
  const pts = data.map((d, i) => `${xOf(i).toFixed(1)},${yOf(d.count).toFixed(1)}`).join(" L ");
  const areaD = `M ${pts} L ${xOf(n - 1).toFixed(1)},${(pad.top + H).toFixed(1)} L ${xOf(0).toFixed(1)},${(pad.top + H).toFixed(1)} Z`;
  const lineD = `M ${pts}`;

  // Y-axis labels (3 ticks)
  const yTicks = [0, Math.round(maxCount / 2), maxCount];
  const yTicksHtml = yTicks.map((v) => {
    const y = yOf(v);
    return `<text x="${(pad.left - 6).toFixed(1)}" y="${y.toFixed(1)}" text-anchor="end" dominant-baseline="middle" fill="var(--text-dim)" font-size="10">${escapeHtml(fmtNum(v))}</text>`;
  }).join("");

  // X-axis labels: show up to 8 evenly-spaced labels
  const maxLabels = 8;
  const step = Math.max(1, Math.floor(n / maxLabels));
  const xLabelsHtml = data
    .map((d, i) => {
      if (i % step !== 0 && i !== n - 1) return "";
      const x = xOf(i);
      // Show only "MM-DD" to save space
      const label = d.date.slice(5); // "YYYY-MM-DD" → "MM-DD"
      return `<text x="${x.toFixed(1)}" y="${(pad.top + H + 14).toFixed(1)}" text-anchor="middle" fill="var(--text-dim)" font-size="9">${escapeHtml(label)}</text>`;
    })
    .join("");

  // Grid lines
  const gridHtml = yTicks.map((v) => {
    const y = yOf(v);
    return `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${(pad.left + W).toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>`;
  }).join("");

  return (
    `<svg class="uchart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">` +
    gridHtml +
    `<path d="${escapeHtml(areaD)}" fill="var(--accent)" fill-opacity="0.15"/>` +
    `<path d="${escapeHtml(lineD)}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/>` +
    yTicksHtml +
    xLabelsHtml +
    `</svg>`
  );
}

/**
 * Build an SVG donut chart for model-mix data.
 * Returns an SVG string (labels HTML-escaped).
 *
 * @param {Array<{model: string, count: number}>} data
 * @param {number} size  Width/height of the square SVG viewport
 * @returns {string}
 */
function buildDonutChart(data, size) {
  if (data.length === 0) return "";
  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.35;
  const r = size * 0.20; // inner radius for the donut hole

  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) return "";

  // Palette — cycle through a small set of colours
  const COLORS = [
    "var(--accent)",
    "var(--accent-2)",
    "var(--ok)",
    "var(--warn)",
    "var(--danger)",
    "#74c7ec",
    "#fab387",
    "#94e2d5",
  ];

  let angle = -Math.PI / 2; // start at 12 o'clock
  let segments = "";
  let legend = "";

  data.forEach((d, i) => {
    const slice = (d.count / total) * 2 * Math.PI;
    const endAngle = angle + slice;
    const color = COLORS[i % COLORS.length];

    // SVG arc path
    const x1 = cx + R * Math.cos(angle);
    const y1 = cy + R * Math.sin(angle);
    const x2 = cx + R * Math.cos(endAngle);
    const y2 = cy + R * Math.sin(endAngle);
    const ix1 = cx + r * Math.cos(endAngle);
    const iy1 = cy + r * Math.sin(endAngle);
    const ix2 = cx + r * Math.cos(angle);
    const iy2 = cy + r * Math.sin(angle);
    const large = slice > Math.PI ? 1 : 0;

    const pct = ((d.count / total) * 100).toFixed(1);
    const shortModel = d.model.replace(/^claude-/, "").replace(/-\d{8}$/, "");

    segments += (
      `<path d="M ${x1.toFixed(2)} ${y1.toFixed(2)} ` +
      `A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} ` +
      `L ${ix1.toFixed(2)} ${iy1.toFixed(2)} ` +
      `A ${r} ${r} 0 ${large} 0 ${ix2.toFixed(2)} ${iy2.toFixed(2)} Z" ` +
      `fill="${color}">` +
      `<title>${escapeHtml(d.model)}: ${escapeHtml(fmtNum(d.count))} (${escapeHtml(pct)}%)</title>` +
      `</path>`
    );

    // Legend entry
    legend += (
      `<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:11px">` +
      `<span style="width:10px;height:10px;border-radius:2px;background:${color};flex-shrink:0;display:inline-block"></span>` +
      `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)">${escapeHtml(shortModel)}</span>` +
      `<span style="color:var(--text-dim);flex-shrink:0">${escapeHtml(pct)}%</span>` +
      `</div>`
    );

    angle = endAngle;
  });

  const svg = (
    `<svg class="uchart" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">` +
    segments +
    `</svg>`
  );

  return (
    `<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">` +
    `<div style="flex-shrink:0">${svg}</div>` +
    `<div style="flex:1;min-width:120px">${legend}</div>` +
    `</div>`
  );
}

/**
 * Build horizontal bar-chart HTML for a list of {label, count} items.
 * All output is HTML-escaped. Returns raw HTML string.
 *
 * @param {Array<{label: string, count: number}>} items
 * @returns {string}
 */
function buildBarChart(items) {
  if (items.length === 0) return `<div class="usage-no-data">No data</div>`;
  const max = Math.max(...items.map((i) => i.count), 1);
  return items
    .map((item) => {
      const pct = ((item.count / max) * 100).toFixed(1);
      return (
        `<div class="usage-bar-row">` +
        `<div class="usage-bar-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</div>` +
        `<div class="usage-bar-track"><div class="usage-bar-fill" style="width:${escapeHtml(pct)}%"></div></div>` +
        `<div class="usage-bar-count">${escapeHtml(fmtNum(item.count))}</div>` +
        `</div>`
      );
    })
    .join("");
}

/**
 * Render the full usage dashboard HTML from a /api/usage response.
 * All user-controlled strings are passed through escapeHtml before insertion.
 *
 * @param {object} data  The UsageResult from /api/usage
 * @returns {string}     innerHTML to set on #usage-body
 */
function renderUsageDashboard(data) {
  // ---------- headline stats ----------
  const totalTokens =
    (data.tokenTotals?.input ?? 0) +
    (data.tokenTotals?.output ?? 0) +
    (data.tokenTotals?.cacheCreate ?? 0) +
    (data.tokenTotals?.cacheRead ?? 0);

  const costHtml =
    typeof data.estimatedCostUsd === "number"
      ? `<div class="usage-stat">` +
        `<div class="usage-stat-value">${escapeHtml(fmtCost(data.estimatedCostUsd))}</div>` +
        `<div class="usage-stat-label">Est. Cost</div>` +
        `<div class="usage-stat-note">estimate only</div>` +
        `</div>`
      : "";

  const statsHtml =
    `<div class="usage-stats">` +
    `<div class="usage-stat">` +
    `<div class="usage-stat-value">${escapeHtml(fmtNum(data.totalSessions ?? 0))}</div>` +
    `<div class="usage-stat-label">Sessions</div>` +
    `</div>` +
    `<div class="usage-stat">` +
    `<div class="usage-stat-value">${escapeHtml(fmtTokens(totalTokens))}</div>` +
    `<div class="usage-stat-label">Total Tokens</div>` +
    `</div>` +
    `<div class="usage-stat">` +
    `<div class="usage-stat-value">${escapeHtml(fmtTokens(data.tokenTotals?.input ?? 0))}</div>` +
    `<div class="usage-stat-label">Input</div>` +
    `</div>` +
    `<div class="usage-stat">` +
    `<div class="usage-stat-value">${escapeHtml(fmtTokens(data.tokenTotals?.output ?? 0))}</div>` +
    `<div class="usage-stat-label">Output</div>` +
    `</div>` +
    `<div class="usage-stat">` +
    `<div class="usage-stat-value">${escapeHtml(fmtTokens((data.tokenTotals?.cacheCreate ?? 0) + (data.tokenTotals?.cacheRead ?? 0)))}</div>` +
    `<div class="usage-stat-label">Cache Tokens</div>` +
    `</div>` +
    costHtml +
    `</div>`;

  // ---------- truncation notice ----------
  const truncNote = data.truncated
    ? `<div class="usage-truncated">⚠ Results are partial — scan limits were hit${data.truncatedNote ? `: ${escapeHtml(data.truncatedNote)}` : ""}.</div>`
    : "";

  // ---------- sessions per project (horizontal bars) ----------
  const projectItems = (data.sessionsPerProject ?? [])
    .slice(0, 20)
    .map((/** @type {{project:string,count:number}} */ p) => ({
      label: state.friendlyNames ? friendlyProjectName(p.project) : p.project,
      count: p.count,
    }));
  const projectChartHtml =
    `<div class="usage-section">` +
    `<div class="usage-section-title">Sessions per Project</div>` +
    `<div class="usage-chart">` +
    (projectItems.length > 0 ? buildBarChart(projectItems) : `<div class="usage-no-data">No sessions found</div>`) +
    `</div></div>`;

  // ---------- messages over time (area chart) ----------
  const timeData = data.messagesOverTime ?? [];
  const timeChartHtml =
    `<div class="usage-section">` +
    `<div class="usage-section-title">Messages Over Time</div>` +
    `<div class="usage-chart">` +
    (timeData.length > 0
      ? buildAreaChart(timeData, 800, 160)
      : `<div class="usage-no-data">No timestamped records found</div>`) +
    `</div></div>`;

  // ---------- model mix (donut chart) ----------
  const modelData = data.modelMix ?? [];
  const modelChartHtml =
    `<div class="usage-section">` +
    `<div class="usage-section-title">Model Mix</div>` +
    `<div class="usage-chart">` +
    (modelData.length > 0
      ? buildDonutChart(modelData.slice(0, 8), 160)
      : `<div class="usage-no-data">No model data found</div>`) +
    `</div></div>`;

  // ---------- history summary ----------
  let historyHtml = "";
  if (data.history) {
    const h = data.history;
    const range =
      h.minTs && h.maxTs
        ? ` · ${escapeHtml(new Date(h.minTs).toLocaleDateString())} – ${escapeHtml(new Date(h.maxTs).toLocaleDateString())}`
        : "";
    historyHtml =
      `<div class="usage-section">` +
      `<div class="usage-section-title">history.jsonl</div>` +
      `<div class="usage-chart" style="font-family:var(--mono);font-size:12px;color:var(--text-dim)">` +
      `${escapeHtml(fmtNum(h.lineCount))} lines${range}` +
      `</div></div>`;
  }

  return truncNote + statsHtml + timeChartHtml + projectChartHtml + modelChartHtml + historyHtml;
}

/** Open the usage dashboard overlay and load data if needed. */
async function openUsageDashboard() {
  const overlay = /** @type {HTMLElement} */ ($("#usage-overlay"));
  const body = /** @type {HTMLElement} */ ($("#usage-body"));
  const genAt = /** @type {HTMLElement} */ ($("#usage-generated-at"));
  overlay.classList.remove("hidden");
  body.innerHTML = `<div class="usage-loading">Loading…</div>`;
  genAt.textContent = "";
  try {
    const data = await api("/api/usage");
    state.lastUsage = data; // cache so the name-mode toggle can re-render
    body.innerHTML = renderUsageDashboard(data);
    if (data.generatedAt) {
      genAt.textContent = `as of ${new Date(data.generatedAt).toLocaleTimeString()}`;
    }
  } catch (e) {
    body.innerHTML = `<div class="usage-error">Failed to load usage data: ${escapeHtml(e.message)}</div>`;
  }
}

/** Close the usage dashboard overlay. */
function closeUsageDashboard() {
  const overlay = /** @type {HTMLElement} */ ($("#usage-overlay"));
  overlay.classList.add("hidden");
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

  // Restore name-mode preference (friendly by default).
  state.friendlyNames = localStorage.getItem("friendlyNames") !== "0";
  updateNamesToggle();
  const friendlyCb = /** @type {HTMLInputElement|null} */ ($("#graph-friendly"));
  if (friendlyCb) friendlyCb.checked = state.friendlyNames;

  await buildTree();

  // Slide-out drawers share the single #backdrop and only one is open at a
  // time. Each toggle closes the others via closeDrawers() then opens its own.
  $("#nav-toggle").addEventListener("click", () => {
    const wasOpen = document.body.classList.contains("tree-open");
    closeDrawers();
    if (!wasOpen) {
      document.body.classList.add("tree-open");
      $("#nav-toggle").setAttribute("aria-expanded", "true");
      syncBackdrop();
    }
  });
  $("#log-toggle").addEventListener("click", () => {
    const wasOpen = document.body.classList.contains("log-open");
    closeDrawers();
    if (!wasOpen) {
      document.body.classList.add("log-open");
      $("#log-toggle").setAttribute("aria-expanded", "true");
      syncBackdrop();
    }
  });

  // Settings panel toggle (settings-explorer).
  let settingsLoaded = false;
  $("#settings-toggle").addEventListener("click", () => {
    if (settingsState.open) {
      closeSettingsPanel();
    } else {
      openSettingsPanel();
    }
  });
  $("#settings-close").addEventListener("click", closeSettingsPanel);
  $("#settings-reveal-btn").addEventListener("click", () => {
    if (settingsState.revealed) return; // already revealed
    showConfirm(
      "Reveal raw settings?",
      "Show the un-redacted settings values? Real API keys or credentials may be displayed.",
      () => {
        settingsState.revealed = true;
        const btn = $("#settings-reveal-btn");
        btn.textContent = "👁 Revealed";
        btn.setAttribute("disabled", "disabled");
        loadSettingsPanel(true);
      },
    );
  });

  // History panel toggle (file-history-diff).
  $("#history-toggle").addEventListener("click", () => {
    if (document.body.classList.contains("history-open")) {
      document.body.classList.remove("history-open");
      $("#history-toggle").setAttribute("aria-expanded", "false");
      syncBackdrop();
    } else {
      openHistoryPanel();
    }
  });
  $("#history-close").addEventListener("click", () => {
    document.body.classList.remove("history-open");
    $("#history-toggle").setAttribute("aria-expanded", "false");
    syncBackdrop();
  });
  $("#history-back").addEventListener("click", () => {
    $("#history-list-area").classList.remove("hidden");
    $("#history-entry-area").classList.add("hidden");
  });

  // Extensions panel toggle (extensions-explorer).
  $("#ext-toggle").addEventListener("click", () => {
    if (document.body.classList.contains("ext-open")) {
      closeDrawers();
    } else {
      openExtensions();
    }
  });
  $("#ext-close").addEventListener("click", closeDrawers);
  for (const btn of document.querySelectorAll(".ext-tab")) {
    btn.addEventListener("click", () => renderExtTab(btn.dataset.tab));
  }

  // Projects panel toggle (project-map).
  let projectsLoaded = false;
  $("#projects-toggle").addEventListener("click", () => {
    const wasOpen = document.body.classList.contains("projects-open");
    closeDrawers();
    if (!wasOpen) {
      document.body.classList.add("projects-open");
      $("#projects-toggle").setAttribute("aria-expanded", "true");
      syncBackdrop();
      if (!projectsLoaded) {
        projectsLoaded = true;
        loadProjects();
      }
    }
  });
  $("#projects-close").addEventListener("click", () => {
    document.body.classList.remove("projects-open");
    $("#projects-toggle").setAttribute("aria-expanded", "false");
    syncBackdrop();
  });

  // Backdrop closes every body-class drawer.
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

  // Audit drawer (security-audit) — standalone, manages its own overlay.
  $("#audit-toggle").addEventListener("click", toggleAuditDrawer);
  $("#audit-close").addEventListener("click", closeAuditDrawer);
  $("#audit-run")?.addEventListener("click", runAudit);

  // Usage dashboard (usage-dashboard) — standalone overlay.
  $("#usage-toggle").addEventListener("click", openUsageDashboard);
  $("#usage-close").addEventListener("click", closeUsageDashboard);
  $("#usage-refresh").addEventListener("click", openUsageDashboard);
  $("#usage-overlay").addEventListener("click", (e) => {
    if (e.target === $("#usage-overlay")) closeUsageDashboard();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#usage-overlay").classList.contains("hidden")) {
      closeUsageDashboard();
    }
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

  // Source cross-reference overlay (source-xref) — standalone overlay.
  $("#btn-xref").addEventListener("click", openXref);
  $("#xref-close").addEventListener("click", closeXref);
  $("#xref-overlay").addEventListener("click", (e) => {
    if (e.target === $("#xref-overlay")) closeXref();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#xref-overlay").classList.contains("hidden")) {
      closeXref();
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

  // Relationship graph (relationship-graph) — standalone canvas overlay.
  setupGraphCanvas();
  $("#graph-toggle").addEventListener("click", openGraph);
  $("#graph-close").addEventListener("click", closeGraph);
  $("#graph-fit").addEventListener("click", () => {
    fitGraph();
    if (!gs.rafId) gs.rafId = requestAnimationFrame(() => { drawGraph(); gs.rafId = null; });
  });
  $("#graph-zoom-in").addEventListener("click", () => zoomBy(1.25));
  $("#graph-zoom-out").addEventListener("click", () => zoomBy(0.8));
  // Filter / layout controls rebuild the graph; search focuses a group.
  for (const id of ["graph-layout", "graph-kind", "graph-topn", "graph-hidetiny"]) {
    $("#" + id).addEventListener("change", () => rebuildGraph());
  }
  // Friendly-names checkbox shares the global mode; only labels change (no relayout).
  $("#graph-friendly").addEventListener("change", (e) => setFriendlyNames(e.target.checked));
  let searchTimer = null;
  $("#graph-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => focusGraphSearch(v), 200);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#graph-overlay").classList.contains("hidden")) {
      closeGraph();
    }
  });
}

// ---------------------------------------------------------------------------
// Relationship graph — force-directed canvas rendering
// ---------------------------------------------------------------------------

/**
 * Maximum number of nodes rendered in the graph (top by degree).
 * Matches GRAPH_NODE_CAP on the server; the server may already cap to 300 but
 * we apply a UI cap here too for initial render performance on mobiles.
 */
const GRAPH_RENDER_CAP = 300;

/** Radii for each node type in canvas units. */
const NODE_RADIUS = { uuid: 7, file: 5 };

/** Fill colours for each node type. */
const NODE_COLOR = { uuid: "#cba6f7", file: "#89b4fa" };

/** Text colour for labels. */
const LABEL_COLOR = "#9399b2";

/** Highlight colour (hovered/selected node). */
const HIGHLIGHT_COLOR = "#f9e2af";

/**
 * Simulation parameters per layout mode. FORCE is the default global
 * force-directed layout; GRID anchors each cluster to its own grid cell.
 */
const SIM_FORCE = {
  springLen: 90, springK: 0.02, repulse: 5000, damping: 0.82,
  center: 0.004, stopThreshold: 0.15, maxIter: 6000, ticksPerFrame: 6,
};
/**
 * Active simulation parameters. Only the force layout runs a simulation; the
 * grid layout is deterministic (see {@link placeGrid}), so this always returns
 * the force parameters.
 */
function simParams() { return SIM_FORCE; }

/** Graph overlay state (reset on each open). */
const gs = {
  nodes: /** @type {Array<{id:string,type:string,label:string,path?:string,degree:number,x:number,y:number,vx:number,vy:number}>} */ ([]),
  edges: /** @type {Array<{source:string,target:string}>} */ ([]),
  nodeMap: /** @type {Map<string,object>} */ (new Map()),
  /** Resolved edges as {a: nodeObj, b: nodeObj} pairs. */
  links: /** @type {Array<{a:object,b:object}>} */ ([]),
  /** Pan offset in canvas pixels. */
  panX: 0,
  panY: 0,
  /** Zoom scale (1 = 1:1). */
  scale: 1,
  /** Hovered node or null. */
  hovered: /** @type {object|null} */ (null),
  /** Simulation iteration counter. */
  iter: 0,
  /** True once the simulation is considered settled. */
  settled: false,
  /** requestAnimationFrame handle. */
  rafId: /** @type {number|null} */ (null),
  truncated: false,
};

/** Client-side UUID matcher (mirrors the server's). */
const GRAPH_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Decode an encoded project dir ("-home-a--b-proj") to a short label. */
function graphProjShort(enc) {
  return friendlyProjectName(enc);
}

/**
 * The label to draw for a graph node, honouring the friendly/UUID name mode.
 * File nodes always show their kind; UUID hubs show the friendly project name
 * (or a short id) in friendly mode, or the full UUID in UUID mode.
 */
function nodeDisplayLabel(nd) {
  if (nd.type !== "uuid") return nd.label;
  if (state.friendlyNames) return `⬢ ${nd.proj || nd.id.slice(0, 8)}`;
  return `⬢ ${nd.id}`;
}

/** Human, descriptive label for a file node derived from its root-relative path. */
function graphFileLabel(path) {
  const parts = path.split("/");
  const top = parts[0] || "";
  if (top === "projects" && parts.length >= 2) return "session";
  if (path.startsWith("cot/transcript")) return "transcript";
  if (top === "cot") return parts[1] || "cot";
  if (top === "shell-snapshots") return "shell snapshot";
  if (top === "todos" || path.includes("/todos/")) return "todo";
  if (top === "tasks" || path.includes("/tasks/")) return "task";
  if (top === "sessions" || top === "session-env") return "session env";
  if (top === "file-history") return "file history";
  if (top === "plans") return "plan";
  // Fallback: parent dir name, else the basename with the UUID stripped.
  if (parts.length > 1) return parts[parts.length - 2];
  return (parts[parts.length - 1] || path).replace(GRAPH_UUID_RE, "").replace(/^[-_.]+|[-_.]+$/g, "") || "file";
}

/**
 * Assign each node a connected-component ("cluster") index and give every
 * cluster a distinct colour (golden-angle hue spread). Edges inherit their
 * cluster's colour. Mutates gs.nodes; sets gs.clusterColors / gs.clusterEdge.
 */
function clusterAndColor() {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const nd of gs.nodes) parent.set(nd.id, nd.id);
  for (const { a, b } of gs.links) { const ra = find(a.id), rb = find(b.id); if (ra !== rb) parent.set(ra, rb); }
  const rootIndex = new Map();
  let next = 0;
  for (const nd of gs.nodes) {
    const r = find(nd.id);
    if (!rootIndex.has(r)) rootIndex.set(r, next++);
    nd.cluster = rootIndex.get(r);
  }
  gs.clusterColors = [];
  gs.clusterEdge = [];
  for (let i = 0; i < next; i++) {
    const hue = Math.round((i * 137.508) % 360);
    gs.clusterColors.push(`hsl(${hue} 70% 66%)`);
    gs.clusterEdge.push(`hsl(${hue} 55% 58% / 0.45)`);
  }
}

/** Zoom by `factor` about a point `(sx, sy)` offset from the canvas centre. */
function zoomBy(factor, sx = 0, sy = 0) {
  gs.panX = sx - factor * (sx - gs.panX);
  gs.panY = sy - factor * (sy - gs.panY);
  gs.scale = Math.min(Math.max(gs.scale * factor, 0.05), 10);
  if (!gs.rafId) gs.rafId = requestAnimationFrame(() => { drawGraph(); gs.rafId = null; });
}

/** Return the canvas element (typed). */
function graphCanvas() {
  return /** @type {HTMLCanvasElement} */ ($("#graph-canvas"));
}

/**
 * Open the graph overlay: fetch data, build nodes, run simulation.
 */
async function openGraph() {
  const overlay = $("#graph-overlay");
  overlay.classList.remove("hidden");
  $("#graph-loading").classList.remove("hidden");
  $("#graph-loading").textContent = "Loading graph…";
  $("#graph-empty").classList.add("hidden");
  $("#graph-stats").textContent = "";
  if (gs.rafId !== null) { cancelAnimationFrame(gs.rafId); gs.rafId = null; }

  let data;
  try {
    data = await api("/api/graph");
  } catch (e) {
    $("#graph-loading").textContent = `Error: ${escapeHtml(e.message)}`;
    return;
  }
  gs.raw = data;
  const friendlyCb = /** @type {HTMLInputElement|null} */ ($("#graph-friendly"));
  if (friendlyCb) friendlyCb.checked = state.friendlyNames;
  $("#graph-loading").classList.add("hidden");
  rebuildGraph();
}

/** Read the filter/layout controls into gs.filter / gs.layout. */
function readGraphControls() {
  gs.layout = $("#graph-layout")?.value || "force";
  gs.filter = {
    minSize: $("#graph-hidetiny")?.checked ? 3 : 1,
    topN: parseInt($("#graph-topn")?.value || "0", 10) || 0,
    kind: $("#graph-kind")?.value || "all",
  };
}

/**
 * Apply the current filters to the raw graph, (re)cluster + colour, lay out
 * per the selected mode, and (re)start the simulation. Runs on open and on any
 * control change. Search is a separate focus action and does not rebuild.
 */
function rebuildGraph() {
  if (!gs.raw) return;
  readGraphControls();
  const overlay = $("#graph-overlay");
  overlay.querySelector(".graph-truncated")?.remove();
  if (gs.rafId !== null) { cancelAnimationFrame(gs.rafId); gs.rafId = null; }

  // 1. Connected components of the full raw graph (for size/kind/top filters).
  const adj = new Map();
  for (const nd of gs.raw.nodes) adj.set(nd.id, []);
  for (const e of gs.raw.edges) { adj.get(e.source)?.push(e.target); adj.get(e.target)?.push(e.source); }
  const compOf = new Map();
  let comp = 0;
  for (const nd of gs.raw.nodes) {
    if (compOf.has(nd.id)) continue;
    const stack = [nd.id];
    compOf.set(nd.id, comp);
    while (stack.length) {
      const cur = stack.pop();
      for (const nb of adj.get(cur) || []) if (!compOf.has(nb)) { compOf.set(nb, comp); stack.push(nb); }
    }
    comp++;
  }
  const members = Array.from({ length: comp }, () => []);
  for (const nd of gs.raw.nodes) members[compOf.get(nd.id)].push(nd);

  // 2. Pick surviving components by the filters.
  const { minSize, topN, kind } = gs.filter;
  let comps = members.map((m, i) => ({ i, m })).filter((c) => c.m.length >= minSize);
  if (kind !== "all") {
    comps = comps.filter((c) => c.m.some((nd) => {
      if (nd.type !== "file") return false;
      if (kind === "session") return !!nd.path && nd.path.startsWith("projects/");
      return graphFileLabel(nd.path || "") === kind;
    }));
  }
  comps.sort((a, b) => b.m.length - a.m.length);
  const groupCount = comps.length;
  if (topN > 0) comps = comps.slice(0, topN);
  const keepId = new Set();
  for (const c of comps) for (const nd of c.m) keepId.add(nd.id);

  let nodes = gs.raw.nodes.filter((nd) => keepId.has(nd.id));
  let edges = gs.raw.edges.filter((e) => keepId.has(e.source) && keepId.has(e.target));

  // 3. Render cap (largest-degree first).
  let truncated = false;
  if (nodes.length > GRAPH_RENDER_CAP) {
    const sorted = [...nodes].sort((a, b) => b.degree - a.degree);
    const kept = new Set(sorted.slice(0, GRAPH_RENDER_CAP).map((n) => n.id));
    nodes = sorted.slice(0, GRAPH_RENDER_CAP);
    edges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));
    truncated = true;
  }

  $("#graph-stats").textContent =
    `${gs.raw.stats.files.toLocaleString()} files · ${gs.raw.stats.uuids.toLocaleString()} UUIDs · ${nodes.length} nodes · ${edges.length} edges · ${groupCount} groups`;
  $("#graph-empty").classList.toggle("hidden", nodes.length > 0);
  if (nodes.length === 0) { gs.nodes = []; gs.links = []; drawGraph(); return; }
  if (truncated) {
    const note = document.createElement("div");
    note.className = "graph-truncated";
    note.textContent = `⚠ Showing top ${GRAPH_RENDER_CAP} nodes; use the filters above to narrow.`;
    overlay.appendChild(note);
  }

  // 4. Build live node/link objects (positions set by the layout step).
  gs.nodeMap.clear();
  gs.nodes = nodes.map((nd) => { const o = { ...nd, x: 0, y: 0, vx: 0, vy: 0 }; gs.nodeMap.set(nd.id, o); return o; });
  gs.links = edges.flatMap((e) => { const a = gs.nodeMap.get(e.source); const b = gs.nodeMap.get(e.target); return a && b ? [{ a, b }] : []; });

  // Descriptive labels (files by kind; hubs by short id → project name).
  for (const nd of gs.nodes) {
    if (nd.type === "file") { nd.full = nd.path; nd.label = graphFileLabel(nd.path); nd.proj = null; }
    else { nd.full = nd.id; nd.label = nd.id; nd.proj = null; } // proj filled below if known
  }
  for (const { a, b } of gs.links) {
    const hub = a.type === "uuid" ? a : b.type === "uuid" ? b : null;
    const file = a.type === "file" ? a : b.type === "file" ? b : null;
    if (hub && file && file.path && file.path.startsWith("projects/")) {
      const enc = file.path.split("/")[1] || "";
      if (enc) hub.proj = friendlyProjectName(enc);
    }
  }

  clusterAndColor();
  if (gs.layout === "grid") placeGrid(); else placeForce();

  gs.panX = 0; gs.panY = 0; gs.scale = 1;
  gs.hovered = null; gs.focusCluster = null; gs.iter = 0;
  gs.settled = gs.layout === "grid"; // grid is pre-laid (static); force animates
  resizeGraphCanvas();
  fitGraph();
  animateGraph();
}

/** Force layout: jittered-circle seed; global repulsion + gentle centering. */
function placeForce() {
  gs.mode = "force";
  gs.clusterCenters = null;
  const n = gs.nodes.length;
  const r0 = Math.max(120, n * 8);
  gs.nodes.forEach((nd, i) => {
    const angle = (2 * Math.PI * i) / n;
    const jitter = r0 * 0.15 * (Math.random() - 0.5);
    nd.x = (r0 + jitter) * Math.cos(angle);
    nd.y = (r0 + jitter) * Math.sin(angle);
    nd.vx = 0; nd.vy = 0;
  });
}

/** Ring spacing and node spacing for the deterministic radial cluster layout. */
const RING_GAP = 42;
const NODE_GAP = 26;

/** Estimate the radius a cluster of `size` occupies under radialLayout. */
function clusterRadius(size) {
  let placed = 0, ring = 1;
  const rest = Math.max(0, size - 1);
  while (placed < rest) {
    const radius = ring * RING_GAP;
    const cap = Math.max(1, Math.floor((2 * Math.PI * radius) / NODE_GAP));
    placed += Math.min(cap, rest - placed);
    ring++;
  }
  return (ring - 1) * RING_GAP + 30;
}

/** Lay a cluster out radially: highest-degree node at centre, rest in rings. */
function radialLayout(group, cx, cy) {
  const sorted = [...group].sort((a, b) => b.degree - a.degree);
  const center = sorted[0];
  center.x = cx; center.y = cy; center.vx = 0; center.vy = 0;
  const rest = sorted.slice(1);
  let idx = 0, ring = 1;
  while (idx < rest.length) {
    const radius = ring * RING_GAP;
    const cap = Math.max(1, Math.floor((2 * Math.PI * radius) / NODE_GAP));
    const here = Math.min(cap, rest.length - idx);
    for (let k = 0; k < here; k++) {
      const ang = (2 * Math.PI * k) / here + ring * 0.6;
      const nd = rest[idx++];
      nd.x = cx + radius * Math.cos(ang);
      nd.y = cy + radius * Math.sin(ang);
      nd.vx = 0; nd.vy = 0;
    }
    ring++;
  }
}

/**
 * Grid layout: each cluster is laid out radially in its own cell, and cells are
 * shelf-packed left-to-right (largest first) with sizes proportional to the
 * cluster — so a dominant cluster gets a big cell and small ones pack tightly.
 * Deterministic (no force sim), so it never explodes.
 */
function placeGrid() {
  gs.mode = "grid";
  gs.clusterCenters = null;
  const groups = [];
  for (const nd of gs.nodes) (groups[nd.cluster] ||= []).push(nd);
  const order = groups.filter(Boolean).sort((a, b) => b.length - a.length);
  const GAP = 30;
  const cells = order.map((g) => { const rad = clusterRadius(g.length); return { g, side: 2 * rad + GAP }; });
  gs.clusterGroups = order;
  const cvEl = graphCanvas();
  const aspect = (cvEl.clientWidth || 1280) / (cvEl.clientHeight || 760);
  const totalArea = cells.reduce((s, c) => s + c.side * c.side, 0);
  const targetW = Math.max(cells.length ? cells[0].side : 1, Math.sqrt(totalArea * aspect));
  let x = 0, y = 0, rowH = 0;
  for (const c of cells) {
    if (x > 0 && x + c.side > targetW) { x = 0; y += rowH; rowH = 0; }
    radialLayout(c.g, x + c.side / 2, y + c.side / 2);
    x += c.side;
    rowH = Math.max(rowH, c.side);
  }
}

/** Schedule a single redraw frame (no simulation step). */
function scheduleGraphDraw() {
  if (!gs.rafId) gs.rafId = requestAnimationFrame(() => { drawGraph(); gs.rafId = null; });
}

/** Focus (highlight + centre) the group matching a search query; dim the rest. */
function focusGraphSearch(query) {
  const q = (query || "").trim().toLowerCase();
  const input = $("#graph-search");
  if (!q) { gs.focusCluster = null; input.classList.remove("nomatch"); scheduleGraphDraw(); return; }
  let best = null;
  for (const nd of gs.nodes) {
    const hay = `${nd.proj || ""} ${nd.label} ${nd.full || ""} ${nd.path || ""}`.toLowerCase();
    if (!hay.includes(q)) continue;
    if (!best || (nd.type === "uuid" && best.type !== "uuid") || nd.degree > best.degree) best = nd;
  }
  if (best) { gs.focusCluster = best.cluster; centerOnCluster(best.cluster); }
  else gs.focusCluster = null; // no match → leave the full graph visible (don't dim all)
  input.classList.toggle("nomatch", !best); // red border signals "no match"
  scheduleGraphDraw();
}

/** Pan/zoom so a cluster fills the view. */
function centerOnCluster(cluster) {
  const ns = gs.nodes.filter((n) => n.cluster === cluster);
  if (!ns.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of ns) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
  const cv = graphCanvas();
  const gw = (maxX - minX) || 1, gh = (maxY - minY) || 1;
  const pad = 120;
  gs.scale = Math.max(0.3, Math.min((cv.width - pad * 2) / gw, (cv.height - pad * 2) / gh, 2.5));
  gs.panX = -((minX + maxX) / 2) * gs.scale;
  gs.panY = -((minY + maxY) / 2) * gs.scale;
}

/** Resize the canvas backing store to match its CSS size. */
function resizeGraphCanvas() {
  const cv = graphCanvas();
  const w = cv.clientWidth || cv.offsetWidth;
  const h = cv.clientHeight || cv.offsetHeight;
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
}

/**
 * One tick of the spring/repulsion simulation.
 * Updates velocities and positions for all nodes.
 * Returns the maximum velocity magnitude (used for settling detection).
 */
function simTick() {
  // Grid layout is deterministic (radial + shelf-packed); no simulation.
  if (gs.mode === "grid") return 0;
  const P = simParams();
  const { springLen, springK, repulse, damping } = P;
  const nodes = gs.nodes;
  const links = gs.links;
  const n = nodes.length;

  for (let i = 0; i < n; i++) { nodes[i].fx = 0; nodes[i].fy = 0; }

  // Spring forces along edges.
  for (const { a, b } of links) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = springK * (dist - springLen);
    const fx = f * (dx / dist);
    const fy = f * (dy / dist);
    a.fx += fx; a.fy += fy;
    b.fx -= fx; b.fy -= fy;
  }

  // Global all-pairs repulsion + gentle centering (force layout).
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist2 = dx * dx + dy * dy || 1;
      const f = repulse / dist2;
      const nx = dx / Math.sqrt(dist2), ny = dy / Math.sqrt(dist2);
      a.fx -= f * nx; a.fy -= f * ny;
      b.fx += f * nx; b.fy += f * ny;
    }
  }
  for (const nd of nodes) { nd.fx -= nd.x * P.center; nd.fy -= nd.y * P.center; }

  // Integrate.
  let maxV = 0;
  for (const nd of nodes) {
    nd.vx = (nd.vx + nd.fx) * damping;
    nd.vy = (nd.vy + nd.fy) * damping;
    nd.x += nd.vx;
    nd.y += nd.vy;
    const v = nd.vx * nd.vx + nd.vy * nd.vy;
    if (v > maxV) maxV = v;
  }
  return Math.sqrt(maxV);
}

/**
 * Draw the current graph state to the canvas.
 * Uses the pan/zoom from `gs.panX / gs.panY / gs.scale`.
 */
function drawGraph() {
  const cv = graphCanvas();
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const w = cv.width, h = cv.height;
  const cx = w / 2 + gs.panX;
  const cy = h / 2 + gs.panY;

  ctx.clearRect(0, 0, w, h);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(gs.scale, gs.scale);

  // When a group is focused (search match or hover), dim everything else.
  const focus = gs.focusCluster != null ? gs.focusCluster : (gs.hovered ? gs.hovered.cluster : null);
  const nodeR = (nd) => (NODE_RADIUS[nd.type] ?? 5) + Math.min(7, Math.sqrt(nd.degree || 1) * 1.4);

  // Edges, coloured by cluster.
  ctx.lineWidth = 1.5 / gs.scale;
  for (const { a, b } of gs.links) {
    ctx.globalAlpha = focus != null && a.cluster !== focus ? 0.05 : 1;
    ctx.strokeStyle = (gs.clusterEdge && gs.clusterEdge[a.cluster]) || "#5a5a78";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Nodes — radius scaled by degree so hubs stand out; UUID hubs are ringed.
  for (const nd of gs.nodes) {
    const isHovered = nd === gs.hovered;
    ctx.globalAlpha = focus != null && nd.cluster !== focus && !isHovered ? 0.12 : 1;
    const r = nodeR(nd);
    const color = (gs.clusterColors && gs.clusterColors[nd.cluster]) || NODE_COLOR[nd.type] || NODE_COLOR.file;
    ctx.beginPath();
    ctx.arc(nd.x, nd.y, isHovered ? r + 3 : r, 0, Math.PI * 2);
    ctx.fillStyle = isHovered ? HIGHLIGHT_COLOR : color;
    ctx.fill();
    if (nd.type === "uuid") {
      ctx.strokeStyle = "#ffffff99";
      ctx.lineWidth = 1.5 / gs.scale;
      ctx.stroke();
    }
    if (isHovered) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2 / gs.scale;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // Labels: hubs + hovered + high-degree, de-overlapped via screen-space boxes.
  const labelThreshold = Math.max(3, Math.floor(gs.nodes.length / 25));
  ctx.font = `${Math.max(9, 11 / gs.scale)}px ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3 / gs.scale;
  const drawnBoxes = [];
  const labelCands = [...gs.nodes].sort(
    (a, b) => (b === gs.hovered ? 1e9 : b.degree) - (a === gs.hovered ? 1e9 : a.degree),
  );
  for (const nd of labelCands) {
    const want = nd === gs.hovered || nd.type === "uuid" || nd.degree >= labelThreshold;
    if (!want) continue;
    if (focus != null && nd.cluster !== focus && nd !== gs.hovered) continue;
    const r = nodeR(nd);
    const raw = nodeDisplayLabel(nd);
    const lbl = raw.length > 24 ? raw.slice(0, 12) + "…" + raw.slice(-8) : raw;
    const lw = ctx.measureText(lbl).width;
    const sx = cx + nd.x * gs.scale;
    const sy = cy + (nd.y + r + 3) * gs.scale;
    const bw = lw * gs.scale + 4, bh = 15;
    const box = { x: sx - bw / 2, y: sy, w: bw, h: bh };
    let overlap = false;
    for (const d of drawnBoxes) {
      if (box.x < d.x + d.w && box.x + box.w > d.x && box.y < d.y + d.h && box.y + box.h > d.y) { overlap = true; break; }
    }
    if (overlap && nd !== gs.hovered) continue;
    drawnBoxes.push(box);
    ctx.strokeStyle = "rgba(17,17,27,0.85)";
    ctx.strokeText(lbl, nd.x, nd.y + r + 3);
    ctx.fillStyle = nd === gs.hovered ? "#ffffff" : LABEL_COLOR;
    ctx.fillText(lbl, nd.x, nd.y + r + 3);
  }

  ctx.restore();
}

/** rAF-driven loop: run simulation ticks then draw. */
function animateGraph() {
  const P = simParams();
  if (!gs.settled) {
    for (let i = 0; i < P.ticksPerFrame; i++) {
      const maxV = simTick();
      gs.iter++;
      if (gs.iter >= P.maxIter || maxV < P.stopThreshold) {
        gs.settled = true;
        break;
      }
    }
  }
  drawGraph();
  if (!gs.settled) {
    gs.rafId = requestAnimationFrame(animateGraph);
  } else {
    gs.rafId = null;
  }
}

/**
 * Fit the graph within the canvas by adjusting pan and scale.
 * Called once after initial node placement and by the "Fit" button.
 */
function fitGraph() {
  if (gs.nodes.length === 0) return;
  const cv = graphCanvas();
  const w = cv.width || cv.offsetWidth;
  const h = cv.height || cv.offsetHeight;

  // Fit to the 2nd–98th percentile of positions so a few far-flung outlier
  // nodes don't shrink the dense core to a dot. Outliers stay reachable by pan.
  const xs = gs.nodes.map((n) => n.x).sort((a, b) => a - b);
  const ys = gs.nodes.map((n) => n.y).sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))))];
  const minX = q(xs, 0.02), maxX = q(xs, 0.98);
  const minY = q(ys, 0.02), maxY = q(ys, 0.98);
  const gw = maxX - minX || 1;
  const gh = maxY - minY || 1;
  const padding = 60;
  const scaleX = (w - padding * 2) / gw;
  const scaleY = (h - padding * 2) / gh;
  gs.scale = Math.min(scaleX, scaleY, 3.5);
  // Centre the graph bounding box.
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  gs.panX = -midX * gs.scale;
  gs.panY = -midY * gs.scale;
}

/**
 * Convert a canvas-relative pointer position to graph (world) coordinates.
 */
function canvasToWorld(cv, clientX, clientY) {
  const rect = cv.getBoundingClientRect();
  const sx = (clientX - rect.left) - (cv.width / 2 + gs.panX);
  const sy = (clientY - rect.top) - (cv.height / 2 + gs.panY);
  return { x: sx / gs.scale, y: sy / gs.scale };
}

/**
 * Find the node under a world-coordinate point, or null.
 */
function nodeAt(wx, wy) {
  // Iterate in reverse so top-painted nodes are hit first.
  for (let i = gs.nodes.length - 1; i >= 0; i--) {
    const nd = gs.nodes[i];
    const r = (NODE_RADIUS[nd.type] ?? 5) + 4; // small hit-padding
    const dx = nd.x - wx, dy = nd.y - wy;
    if (dx * dx + dy * dy <= r * r) return nd;
  }
  return null;
}

/** Wire up pan/hover/click events on the graph canvas. */
function setupGraphCanvas() {
  const cv = graphCanvas();
  const tooltip = $("#graph-tooltip");
  const pointers = new Map();
  let isPanning = false;
  let panStartX = 0, panStartY = 0;
  let panOriginX = 0, panOriginY = 0;
  let didPan = false;
  let pinchDist = 0;

  // Pointer events (mouse + touch). One pointer pans; two pinch-zoom.
  cv.addEventListener("pointerdown", (e) => {
    cv.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      isPanning = true;
      didPan = false;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panOriginX = gs.panX;
      panOriginY = gs.panY;
    } else if (pointers.size === 2) {
      isPanning = false;
      const [p1, p2] = [...pointers.values()];
      pinchDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    }
  });

  cv.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two-finger pinch zoom, centred on the gesture midpoint.
    if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (pinchDist > 0 && d > 0) {
        const rect = cv.getBoundingClientRect();
        const mx = (p1.x + p2.x) / 2 - rect.left - cv.width / 2;
        const my = (p1.y + p2.y) / 2 - rect.top - cv.height / 2;
        zoomBy(d / pinchDist, mx, my);
      }
      pinchDist = d;
      didPan = true;
      gs.hovered = null;
      tooltip.classList.add("hidden");
      return;
    }

    const { x: wx, y: wy } = canvasToWorld(cv, e.clientX, e.clientY);

    if (isPanning) {
      const dx = e.clientX - panStartX;
      const dy = e.clientY - panStartY;
      if (Math.abs(dx) + Math.abs(dy) > 3) didPan = true;
      gs.panX = panOriginX + dx;
      gs.panY = panOriginY + dy;
      gs.hovered = null;
      tooltip.classList.add("hidden");
      if (!gs.rafId) gs.rafId = requestAnimationFrame(animateGraph);
      return;
    }

    const nd = nodeAt(wx, wy);
    if (nd !== gs.hovered) {
      gs.hovered = nd;
      if (!gs.rafId) gs.rafId = requestAnimationFrame(() => { drawGraph(); gs.rafId = null; });
    }
    if (nd) {
      // Display label + full path/UUID underneath.
      const label = nd.full ? `${nodeDisplayLabel(nd)}\n${nd.full}` : nodeDisplayLabel(nd);
      tooltip.textContent = label;
      tooltip.classList.remove("hidden");
      const tw = tooltip.offsetWidth || 200;
      const th = tooltip.offsetHeight || 40;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let tx = e.clientX + 14;
      let ty = e.clientY - 8;
      if (tx + tw > vw - 8) tx = e.clientX - tw - 14;
      if (ty + th > vh - 8) ty = e.clientY - th - 8;
      tooltip.style.left = `${tx}px`;
      tooltip.style.top = `${ty}px`;
    } else {
      tooltip.classList.add("hidden");
    }
  });

  const endPointer = (e) => {
    const wasSingle = pointers.size === 1;
    pointers.delete(e.pointerId);
    try { cv.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) {
      if (!didPan && wasSingle) {
        // Tap (no drag) on a file node opens it.
        const { x: wx, y: wy } = canvasToWorld(cv, e.clientX, e.clientY);
        const nd = nodeAt(wx, wy);
        if (nd && nd.type === "file" && nd.path) {
          closeGraph();
          openFile(nd.path, false);
        }
      }
      isPanning = false;
      didPan = false;
    } else if (pointers.size === 1) {
      // Resume single-finger panning with the remaining pointer.
      const [only] = [...pointers.values()];
      isPanning = true;
      didPan = true;
      panStartX = only.x;
      panStartY = only.y;
      panOriginX = gs.panX;
      panOriginY = gs.panY;
    }
  };
  cv.addEventListener("pointerup", endPointer);
  cv.addEventListener("pointercancel", endPointer);

  cv.addEventListener("pointerleave", () => {
    gs.hovered = null;
    tooltip.classList.add("hidden");
    if (!gs.rafId && !gs.settled) gs.rafId = requestAnimationFrame(animateGraph);
    else if (!gs.rafId) gs.rafId = requestAnimationFrame(() => { drawGraph(); gs.rafId = null; });
  });

  // Zoom via wheel.
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const rect = cv.getBoundingClientRect();
    // Zoom towards the cursor.
    const cx = e.clientX - rect.left - cv.width / 2;
    const cy = e.clientY - rect.top - cv.height / 2;
    gs.panX = cx - factor * (cx - gs.panX);
    gs.panY = cy - factor * (cy - gs.panY);
    gs.scale = Math.min(Math.max(gs.scale * factor, 0.05), 10);
    if (!gs.rafId) gs.rafId = requestAnimationFrame(() => { drawGraph(); gs.rafId = null; });
  }, { passive: false });

  // Keyboard: Escape closes the overlay; "f" fits to screen.
  cv.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeGraph();
    if (e.key === "f" || e.key === "F") {
      fitGraph();
      if (!gs.rafId) gs.rafId = requestAnimationFrame(() => { drawGraph(); gs.rafId = null; });
    }
  });

  // Resize: keep canvas backing store in sync with its CSS size.
  let resizeTimer = null;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeGraphCanvas();
      if (!gs.rafId) gs.rafId = requestAnimationFrame(() => { drawGraph(); gs.rafId = null; });
    }, 50);
  });
  ro.observe(cv);
  // Store observer so we can disconnect on close.
  cv._resizeObserver = ro;
}

/** Close the graph overlay and stop any running simulation. */
function closeGraph() {
  $("#graph-overlay").classList.add("hidden");
  $("#graph-tooltip").classList.add("hidden");
  if (gs.rafId !== null) { cancelAnimationFrame(gs.rafId); gs.rafId = null; }
}

// ---------------------------------------------------------------------------
// Activity timeline — calendar heatmap + hour-of-day bar chart
// ---------------------------------------------------------------------------

/**
 * Fetch activity data from the API and render the timeline panel.
 *
 * @param {number} days - Window size in calendar days (1–365).
 */
async function loadTimeline(days) {
  const body = $("#timeline-body");
  body.innerHTML = '<div class="timeline-loading">Loading…</div>';
  let data;
  try {
    data = await api(`/api/activity?days=${encodeURIComponent(days)}`);
  } catch (e) {
    body.innerHTML = `<div class="timeline-loading">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  body.innerHTML = "";
  body.appendChild(renderTimeline(data));
}

/**
 * Build the full timeline DOM from an API response.
 *
 * @param {object} data - ActivityResult from /api/activity.
 * @returns {HTMLElement}
 */
function renderTimeline(data) {
  const wrap = document.createElement("div");
  wrap.className = "tl-wrap";

  // Stats row.
  wrap.appendChild(renderTimelineStats(data));

  // Calendar heatmap.
  const heatSection = document.createElement("div");
  heatSection.className = "tl-section";
  const heatTitle = document.createElement("div");
  heatTitle.className = "tl-section-title";
  heatTitle.textContent = "Changes per day";
  heatSection.appendChild(heatTitle);
  heatSection.appendChild(renderHeatmap(data.days));
  heatSection.appendChild(renderHeatmapLegend(data.days));
  wrap.appendChild(heatSection);

  // Hour-of-day bar chart.
  const hourSection = document.createElement("div");
  hourSection.className = "tl-section";
  const hourTitle = document.createElement("div");
  hourTitle.className = "tl-section-title";
  hourTitle.textContent = "Activity by hour of day (UTC)";
  hourSection.appendChild(hourTitle);
  hourSection.appendChild(renderHourChart(data.byHour));
  wrap.appendChild(hourSection);

  if (data.truncated) {
    const note = document.createElement("div");
    note.className = "tl-note";
    note.textContent = "⚠ Large tree: scan was capped at 20 000 files. Counts may be partial.";
    wrap.appendChild(note);
  }

  return wrap;
}

/**
 * Render summary statistics (total, busiest day/hour).
 *
 * @param {object} data - ActivityResult.
 * @returns {HTMLElement}
 */
function renderTimelineStats(data) {
  const row = document.createElement("div");
  row.className = "tl-stats";

  /** @param {string} label @param {string} value */
  function stat(label, value) {
    const cell = document.createElement("div");
    cell.className = "tl-stat";
    const l = document.createElement("div");
    l.className = "tl-stat-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "tl-stat-value";
    v.textContent = value;
    cell.append(l, v);
    return cell;
  }

  row.appendChild(stat("Total file changes", data.total.toLocaleString()));

  if (data.busiestDay) {
    row.appendChild(stat("Busiest day", `${data.busiestDay.date} (${data.busiestDay.count.toLocaleString()})`));
  } else {
    row.appendChild(stat("Busiest day", "—"));
  }

  if (data.busiestHour !== null) {
    const h = data.busiestHour.hour;
    const label = `${String(h).padStart(2, "0")}:00 UTC (${data.busiestHour.count.toLocaleString()})`;
    row.appendChild(stat("Busiest hour", label));
  } else {
    row.appendChild(stat("Busiest hour", "—"));
  }

  return row;
}

/**
 * Compute the 5 colour thresholds for the heatmap cells.
 *
 * Levels: 0 = empty, 1–4 = quartile-ish buckets computed from the non-zero
 * days. This mirrors how GitHub's contribution graph works (no activity uses a
 * neutral colour; each non-zero level is progressively more saturated).
 *
 * @param {Array<{date:string,count:number}>} days
 * @returns {[number,number,number,number]} - thresholds for levels 1-4
 */
function computeHeatThresholds(days) {
  const nonZero = days.map((d) => d.count).filter((c) => c > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return [1, 2, 3, 4];
  const max = nonZero[nonZero.length - 1];
  // Simple linear quartiles from 1..max.
  return [
    Math.max(1, Math.ceil(max * 0.25)),
    Math.max(2, Math.ceil(max * 0.50)),
    Math.max(3, Math.ceil(max * 0.75)),
    max,
  ];
}

/**
 * Map a count to a heatmap level 0-4.
 *
 * @param {number} count
 * @param {[number,number,number,number]} thresholds
 * @returns {0|1|2|3|4}
 */
function heatLevel(count, thresholds) {
  if (count === 0) return 0;
  if (count <= thresholds[0]) return 1;
  if (count <= thresholds[1]) return 2;
  if (count <= thresholds[2]) return 3;
  return 4;
}

/**
 * Render a GitHub-style calendar heatmap grid.
 *
 * Cells are arranged as a grid of weeks (columns) × weekdays (rows, 0=Sun).
 * Weeks run left-to-right from oldest to newest. The first column may have
 * blank cells above the first data day.
 *
 * @param {Array<{date:string,count:number}>} days - sorted ascending.
 * @returns {HTMLElement}
 */
function renderHeatmap(days, onDayClick) {
  const thresholds = computeHeatThresholds(days);

  // Build a map: YYYY-MM-DD → {count, level}.
  /** @type {Map<string, {count:number,level:number}>} */
  const byDate = new Map();
  for (const d of days) {
    byDate.set(d.date, { count: d.count, level: heatLevel(d.count, thresholds) });
  }

  // Determine grid bounds: start = first day, rounded back to the preceding Sunday.
  if (days.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tl-heatmap-empty";
    empty.textContent = "No data.";
    return empty;
  }

  const firstDate = days[0].date;
  const lastDate = days[days.length - 1].date;

  // Parse YYYY-MM-DD as UTC.
  const firstMs = Date.UTC(...ymdParts(firstDate));
  const lastMs = Date.UTC(...ymdParts(lastDate));

  // Rewind to the Sunday that starts the first week.
  const firstDow = new Date(firstMs).getUTCDay(); // 0=Sun
  const gridStartMs = firstMs - firstDow * 86_400_000;

  // Count total weeks.
  const totalDays = Math.round((lastMs - gridStartMs) / 86_400_000) + 1;
  const totalWeeks = Math.ceil(totalDays / 7);

  // Day-row labels.
  const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Scrollable container (enables horizontal scroll on mobile).
  const scroll = document.createElement("div");
  scroll.className = "tl-heatmap-scroll";

  // Outer flex: day labels + grid.
  const outer = document.createElement("div");
  outer.className = "tl-heatmap-outer";
  scroll.appendChild(outer);

  // Day-of-week labels on the left (only Mon/Wed/Fri to save space).
  const labelCol = document.createElement("div");
  labelCol.className = "tl-heatmap-labels";
  for (let dow = 0; dow < 7; dow++) {
    const lbl = document.createElement("div");
    lbl.className = "tl-heatmap-daylabel";
    // Show Mon/Wed/Fri labels only — others are spacers.
    lbl.textContent = (dow === 1 || dow === 3 || dow === 5) ? DAY_LABELS[dow] : "";
    labelCol.appendChild(lbl);
  }
  outer.appendChild(labelCol);

  // Grid: one column per week.
  const grid = document.createElement("div");
  grid.className = "tl-heatmap-grid";
  outer.appendChild(grid);

  // Tooltip element (shared, positioned absolutely).
  const tooltip = document.createElement("div");
  tooltip.className = "tl-tooltip hidden";
  scroll.appendChild(tooltip);

  for (let week = 0; week < totalWeeks; week++) {
    const col = document.createElement("div");
    col.className = "tl-heatmap-week";
    for (let dow = 0; dow < 7; dow++) {
      const cellMs = gridStartMs + (week * 7 + dow) * 86_400_000;
      const label = msToDateLabelBrowser(cellMs);
      const info = byDate.get(label);
      const cell = document.createElement("div");

      if (cellMs < firstMs || cellMs > lastMs) {
        cell.className = "tl-cell tl-cell-out";
      } else {
        const level = info ? info.level : 0;
        cell.className = `tl-cell tl-cell-${level}`;
        const countVal = info ? info.count : 0;
        cell.setAttribute("aria-label", `${label} · ${countVal} change${countVal !== 1 ? "s" : ""}`);
        cell.dataset.date = label;
        // Optional drill-down: invoke the callback (in addition to the tooltip).
        if (typeof onDayClick === "function") {
          cell.style.cursor = "pointer";
          cell.addEventListener("click", () => onDayClick(label, countVal));
        }
        // Tooltip on hover.
        cell.addEventListener("mouseenter", (e) => {
          tooltip.textContent = `${escapeHtml(label)} · ${countVal.toLocaleString()} change${countVal !== 1 ? "s" : ""}`;
          tooltip.classList.remove("hidden");
          positionTooltip(tooltip, /** @type {MouseEvent} */ (e));
        });
        cell.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));
        cell.addEventListener("mousemove", (e) => positionTooltip(tooltip, /** @type {MouseEvent} */ (e)));
        // Mobile: tap to show tooltip.
        cell.addEventListener("click", (e) => {
          e.stopPropagation();
          tooltip.textContent = `${escapeHtml(label)} · ${countVal.toLocaleString()} change${countVal !== 1 ? "s" : ""}`;
          tooltip.classList.remove("hidden");
          positionTooltip(tooltip, /** @type {MouseEvent} */ (e));
          setTimeout(() => tooltip.classList.add("hidden"), 2000);
        });
      }
      col.appendChild(cell);
    }
    grid.appendChild(col);
  }

  return scroll;
}

/**
 * Render the heatmap colour legend.
 *
 * @param {Array<{date:string,count:number}>} days
 * @returns {HTMLElement}
 */
function renderHeatmapLegend(days) {
  const legend = document.createElement("div");
  legend.className = "tl-legend";
  const less = document.createElement("span");
  less.className = "tl-legend-label";
  less.textContent = "Less";
  legend.appendChild(less);
  for (let lvl = 0; lvl <= 4; lvl++) {
    const swatch = document.createElement("div");
    swatch.className = `tl-cell tl-cell-${lvl}`;
    legend.appendChild(swatch);
  }
  const more = document.createElement("span");
  more.className = "tl-legend-label";
  more.textContent = "More";
  legend.appendChild(more);
  return legend;
}

/**
 * Render the hour-of-day bar chart (24 bars, 0=midnight).
 *
 * @param {number[]} byHour - 24-element array of counts.
 * @returns {HTMLElement}
 */
function renderHourChart(byHour) {
  const max = Math.max(1, ...byHour);
  const wrap = document.createElement("div");
  wrap.className = "tl-hours";

  for (let h = 0; h < 24; h++) {
    const count = byHour[h] ?? 0;
    const pct = (count / max) * 100;

    const bar = document.createElement("div");
    bar.className = "tl-hour-bar";
    bar.setAttribute("aria-label", `${String(h).padStart(2, "0")}:00 — ${count}`);
    bar.title = `${String(h).padStart(2, "0")}:00 UTC — ${count.toLocaleString()} change${count !== 1 ? "s" : ""}`;

    const fill = document.createElement("div");
    fill.className = "tl-hour-fill";
    fill.style.height = `${pct.toFixed(1)}%`;

    const lbl = document.createElement("div");
    lbl.className = "tl-hour-label";
    // Show every 3rd hour label (0, 3, 6, …) to avoid crowding.
    lbl.textContent = h % 3 === 0 ? String(h).padStart(2, "0") : "";

    bar.append(fill, lbl);
    wrap.appendChild(bar);
  }
  return wrap;
}

/**
 * Position a floating tooltip near the pointer, keeping it within the overlay.
 *
 * @param {HTMLElement} tooltip
 * @param {MouseEvent} e
 */
function positionTooltip(tooltip, e) {
  // Compute position relative to the scroll container's bounding box.
  const scrollEl = tooltip.parentElement;
  const rect = scrollEl ? scrollEl.getBoundingClientRect() : { left: 0, top: 0, width: 9999, height: 9999 };
  let x = e.clientX - rect.left + 8;
  let y = e.clientY - rect.top - 28;
  // Clamp so the tooltip stays inside the scroll container.
  const tw = tooltip.offsetWidth || 180;
  if (x + tw > rect.width) x = rect.width - tw - 4;
  if (x < 4) x = 4;
  if (y < 4) y = 4;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

/**
 * Format an epoch-ms timestamp as `YYYY-MM-DD` using UTC (browser-safe).
 *
 * This mirrors the server's {@link msToDateLabel} using UTC so that dates
 * displayed in the heatmap match the API's bucket keys.
 *
 * @param {number} ms
 * @returns {string}
 */
function msToDateLabelBrowser(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parse a `YYYY-MM-DD` string into `[year, month-1, day]` for use with
 * `Date.UTC(...)`. Returns a tuple compatible with spread into `Date.UTC`.
 *
 * @param {string} label
 * @returns {[number, number, number]}
 */
function ymdParts(label) {
  const [y, m, d] = label.split("-").map(Number);
  return [y, m - 1, d];
}

// Wire up the timeline toggle and close button.
(function setupTimeline() {
  const overlay = /** @type {HTMLElement} */ (document.getElementById("timeline-overlay"));
  const toggleBtn = /** @type {HTMLElement} */ (document.getElementById("timeline-toggle"));
  const closeBtn = /** @type {HTMLElement} */ (document.getElementById("timeline-close"));
  const daysSelect = /** @type {HTMLSelectElement} */ (document.getElementById("timeline-days"));

  if (!overlay || !toggleBtn || !closeBtn || !daysSelect) return;

  function openTimeline() {
    overlay.classList.remove("hidden");
    toggleBtn.setAttribute("aria-expanded", "true");
    loadTimeline(parseInt(daysSelect.value, 10) || 90);
  }

  function closeTimeline() {
    overlay.classList.add("hidden");
    toggleBtn.setAttribute("aria-expanded", "false");
  }

  toggleBtn.addEventListener("click", () => {
    if (overlay.classList.contains("hidden")) {
      openTimeline();
    } else {
      closeTimeline();
    }
  });

  closeBtn.addEventListener("click", closeTimeline);

  // Close on backdrop click (clicking outside the panel).
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeTimeline();
  });

  // Close on Escape.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.classList.contains("hidden")) closeTimeline();
  });

  // Reload when the days selector changes.
  daysSelect.addEventListener("change", () => {
    loadTimeline(parseInt(daysSelect.value, 10) || 90);
  });
})();

// ---------------------------------------------------------------------------
// Grouped "Views" menu — a single dropdown that delegates to the (hidden)
// per-feature toggle buttons, so each feature's wiring is reused unchanged.
// ---------------------------------------------------------------------------
(function setupViewsMenu() {
  const btn = document.getElementById("views-btn");
  const menu = document.getElementById("views-menu");
  if (!btn || !menu) return;
  const close = () => {
    menu.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !menu.classList.toggle("hidden");
    btn.setAttribute("aria-expanded", String(open));
  });
  for (const item of menu.querySelectorAll(".views-item")) {
    item.addEventListener("click", () => {
      if (!item.dataset.target) return; // non-navigation items (e.g. the names toggle)
      const target = document.querySelector(item.dataset.target);
      close();
      if (target) target.click(); // reuse the feature's own open/close handler
    });
  }
  // Names mode toggle — flips friendly/UUID, persists, and re-renders open views
  // without closing the menu (so the change is visible).
  const namesToggle = document.getElementById("names-toggle");
  if (namesToggle) {
    namesToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      setFriendlyNames(!state.friendlyNames);
    });
  }
  // Dismiss on outside click or Escape.
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") && !e.target.closest(".menu")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
})();

// ---------------------------------------------------------------------------
// Observability dashboard — server RED metrics + persistent .claude usage
// history. Reuses the timeline's heatmap / hour-chart components, since the
// /api/observability aggregate exposes the same `days` / `byHour` shapes.
// ---------------------------------------------------------------------------

/**
 * Fetch and render the observability dashboard.
 *
 * @param {number} days - History window (1–365).
 */
async function loadObservability(days) {
  const body = $("#obs-body");
  body.innerHTML = '<div class="timeline-loading">Loading…</div>';
  let data;
  try {
    data = await api(`/api/observability?days=${encodeURIComponent(days)}`);
  } catch (e) {
    body.innerHTML = `<div class="timeline-loading">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  body.innerHTML = "";
  body.appendChild(renderObservability(data));
}

/** Format a byte count as a compact human string. */
function obsBytes(n) {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/** Format a millisecond duration as `Xd Yh`, `Yh Zm`, or `Zm Ss`. */
function obsDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

/** Relative "time ago" for an epoch-ms timestamp. */
function obsAgo(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Build the observability DOM from an /api/observability response.
 *
 * @param {object} data - { aggregate, recent, metrics, journalDir }.
 * @returns {HTMLElement}
 */
/** Absolute short timestamp label for a drill row. */
function obsTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A labelled stat card; if `onClick` is given the card becomes interactive. */
function obsStat(label, value, hint, onClick) {
  const cell = document.createElement("div");
  cell.className = "tl-stat" + (onClick ? " obs-stat-click" : "");
  const l = document.createElement("div");
  l.className = "tl-stat-label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "tl-stat-value";
  v.textContent = value;
  cell.append(l, v);
  if (hint) {
    const h = document.createElement("div");
    h.className = "obs-stat-hint";
    h.textContent = hint;
    cell.appendChild(h);
  }
  if (onClick) {
    cell.tabIndex = 0;
    cell.addEventListener("click", onClick);
    cell.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    });
  }
  return cell;
}

/** A titled section wrapper. */
function obsSection(title, node) {
  const sec = document.createElement("div");
  sec.className = "tl-section";
  const t = document.createElement("div");
  t.className = "tl-section-title";
  t.textContent = title;
  sec.append(t, node);
  return sec;
}

/** Latency histogram (one bar per bucket). */
function renderLatencyHistogram(latency) {
  const buckets = latency.buckets || [];
  const max = Math.max(1, ...buckets.map((b) => b.count || 0));
  const list = document.createElement("div");
  list.className = "obs-bars";
  buckets.forEach((b, i) => {
    const row = document.createElement("div");
    row.className = "obs-bar-row";
    const name = document.createElement("span");
    name.className = "obs-bar-label";
    const lo = i === 0 ? 0 : buckets[i - 1].leMs;
    name.textContent = b.leMs === null ? `> ${lo} ms` : `≤ ${b.leMs} ms`;
    const track = document.createElement("span");
    track.className = "obs-bar-track";
    const fill = document.createElement("span");
    fill.className = "obs-bar-fill";
    fill.style.width = `${b.count ? Math.max(3, (b.count / max) * 100) : 0}%`;
    track.appendChild(fill);
    const val = document.createElement("span");
    val.className = "obs-bar-value";
    val.textContent = (b.count || 0).toLocaleString();
    row.append(name, track, val);
    list.appendChild(row);
  });
  return list;
}

/** Status-class distribution: a stacked bar + a legend. */
function renderStatusBar(byClass, total) {
  const wrap = document.createElement("div");
  const bar = document.createElement("div");
  bar.className = "obs-status-bar";
  const legend = document.createElement("div");
  legend.className = "obs-status-legend";
  const sum = total || Object.values(byClass).reduce((s, n) => s + n, 0) || 1;
  for (const cls of ["2xx", "3xx", "4xx", "5xx", "other"]) {
    const n = byClass[cls] || 0;
    if (!n) continue;
    const seg = document.createElement("span");
    seg.className = `obs-status-seg cls-${cls}`;
    seg.style.width = `${(n / sum) * 100}%`;
    seg.title = `${cls}: ${n}`;
    bar.appendChild(seg);
    const li = document.createElement("span");
    li.className = "obs-status-li";
    const dot = document.createElement("span");
    dot.className = `obs-status-dot cls-${cls}`;
    li.append(dot, document.createTextNode(`${cls} ${n.toLocaleString()} (${((n / sum) * 100).toFixed(0)}%)`));
    legend.appendChild(li);
  }
  wrap.append(bar, legend);
  return wrap;
}

/** Per-route KPI table; clicking a row drills into that route's breakdown. */
function renderRouteTable(byRoute, totalReq) {
  const rows = Object.entries(byRoute).sort((a, b) => b[1].count - a[1].count);
  const table = document.createElement("table");
  table.className = "obs-table";
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th>Route</th><th>Reqs</th><th>Share</th><th>2xx</th><th>4xx</th><th>5xx</th><th>avg</th><th>max</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const [label, s] of rows) {
    const tr = document.createElement("tr");
    tr.className = "obs-table-row";
    tr.title = "Click for this route's breakdown";
    const share = totalReq ? `${((s.count / totalReq) * 100).toFixed(0)}%` : "—";
    const cells = [
      label,
      s.count.toLocaleString(),
      share,
      (s.byClass["2xx"] || 0).toLocaleString(),
      (s.byClass["4xx"] || 0).toLocaleString(),
      (s.byClass["5xx"] || 0).toLocaleString(),
      `${(s.avgMs || 0).toFixed(1)}ms`,
      `${Math.round(s.maxMs || 0)}ms`,
    ];
    cells.forEach((c, i) => {
      const td = document.createElement("td");
      td.textContent = c;
      if (i === 0) td.className = "obs-table-route";
      if (i >= 3 && i <= 5 && c !== "0") td.className = `obs-cls-${["2xx", "4xx", "5xx"][i - 3]}`;
      tr.appendChild(td);
    });
    tr.addEventListener("click", () => obsDrillRoute(label, s));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  const scroll = document.createElement("div");
  scroll.className = "obs-table-scroll";
  scroll.appendChild(table);
  return scroll;
}

/** Remove any open drill-down detail panel. */
function closeObsDrill() {
  const ex = document.querySelector("#obs-body .obs-drill");
  if (ex) ex.remove();
}

/** Open a drill-down detail panel at the top of the observability body. */
function openObsDrill(title, bodyNode) {
  const body = $("#obs-body");
  if (!body) return;
  closeObsDrill();
  const panel = document.createElement("div");
  panel.className = "obs-drill";
  const head = document.createElement("div");
  head.className = "obs-drill-head";
  const t = document.createElement("span");
  t.className = "obs-drill-title";
  t.textContent = title;
  const x = document.createElement("button");
  x.className = "btn obs-drill-close";
  x.textContent = "✕";
  x.title = "Close detail";
  x.addEventListener("click", closeObsDrill);
  head.append(t, x);
  panel.append(head, bodyNode);
  body.insertBefore(panel, body.firstChild);
  panel.scrollIntoView({ block: "start", behavior: "smooth" });
}

/** Drill into a single route's metrics (no fetch — derived from the snapshot). */
function obsDrillRoute(label, s) {
  const wrap = document.createElement("div");
  const stats = document.createElement("div");
  stats.className = "tl-stats";
  stats.append(
    obsStat("Requests", s.count.toLocaleString()),
    obsStat("Avg latency", `${(s.avgMs || 0).toFixed(1)} ms`),
    obsStat("Max latency", `${Math.round(s.maxMs || 0)} ms`),
  );
  wrap.appendChild(stats);
  wrap.appendChild(renderStatusBar(s.byClass, s.count));
  openObsDrill(`Route · ${label}`, wrap);
}

/** Render a fetched journal slice ({events, summary}) into a detail body. */
function renderEventDrill(resp) {
  const wrap = document.createElement("div");
  const s = resp.summary || { count: 0, byKind: {}, byOp: {}, topPaths: [] };

  const stats = document.createElement("div");
  stats.className = "tl-stats";
  stats.appendChild(obsStat("Events", (s.count || 0).toLocaleString()));
  if (s.firstTs) stats.appendChild(obsStat("First", obsTime(s.firstTs)));
  if (s.lastTs) stats.appendChild(obsStat("Last", obsTime(s.lastTs)));
  const ops = Object.entries(s.byOp || {});
  if (ops.length) stats.appendChild(obsStat("Ops", ops.map(([k, v]) => `${k}:${v}`).join("  ")));
  wrap.appendChild(stats);

  if ((s.topPaths || []).length > 1) {
    wrap.appendChild(obsSection("Top paths", renderObsPathList(s.topPaths)));
  }

  const list = document.createElement("div");
  list.className = "obs-events";
  for (const ev of resp.events || []) {
    list.appendChild(renderObsEventRow(ev, true));
  }
  if (!(resp.events || []).length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No events match.";
    list.appendChild(empty);
  }
  wrap.appendChild(obsSection(`Events (${(resp.events || []).length})`, list));
  return wrap;
}

/** Fetch a journal slice by query params and show it as a drill panel. */
async function obsDrillFetch(title, params) {
  const qs = new URLSearchParams(params).toString();
  const loading = document.createElement("div");
  loading.className = "empty";
  loading.textContent = "Loading…";
  openObsDrill(title, loading);
  try {
    const resp = await api(`/api/journal?${qs}`);
    openObsDrill(title, renderEventDrill(resp));
  } catch (e) {
    const err = document.createElement("div");
    err.className = "empty";
    err.textContent = `Error: ${e.message}`;
    openObsDrill(title, err);
  }
}

/** A clickable list of {path,count} rows (open-file on click). */
function renderObsPathList(paths) {
  const list = document.createElement("div");
  list.className = "obs-paths";
  for (const p of paths) {
    const row = document.createElement("div");
    row.className = "obs-path-row";
    const a = document.createElement("button");
    a.className = "obs-path-link";
    a.textContent = p.path;
    a.title = `Open ${p.path}`;
    a.addEventListener("click", () => openFile(p.path, false));
    const hist = document.createElement("button");
    hist.className = "obs-path-hist";
    hist.textContent = "⤵ history";
    hist.title = "Show this path's event history";
    hist.addEventListener("click", () =>
      obsDrillFetch(`Path history · ${p.path}`, { path: p.path, limit: "500" }),
    );
    const c = document.createElement("span");
    c.className = "obs-path-count";
    c.textContent = p.count.toLocaleString();
    row.append(a, hist, c);
    list.appendChild(row);
  }
  return list;
}

/** A single event row; when `clickable`, the path opens the file. */
function renderObsEventRow(ev, clickable) {
  const row = document.createElement("div");
  row.className = "obs-event-row";
  const badge = document.createElement("span");
  badge.className = `obs-event-kind kind-${escapeHtml(ev.kind)}`;
  badge.textContent = ev.op ? `${ev.kind}:${ev.op}` : ev.kind;
  const detail = document.createElement("span");
  detail.className = "obs-event-detail";
  detail.textContent = ev.path || ev.msg || "";
  detail.title = detail.textContent;
  if (clickable && ev.path) {
    detail.classList.add("obs-event-link");
    detail.addEventListener("click", () => openFile(ev.path, false));
  }
  const when = document.createElement("span");
  when.className = "obs-event-when";
  when.textContent = obsAgo(ev.ts);
  when.title = obsTime(ev.ts);
  row.append(badge, detail, when);
  return row;
}

function renderObservability(data) {
  const m = data.metrics || {};
  const agg = data.aggregate || { days: [], byHour: [], byKind: {}, topPaths: [], total: 0 };
  const wrap = document.createElement("div");
  wrap.className = "tl-wrap";

  // --- Server health (RED) --------------------------------------------------
  const lat = m.latency || { avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, buckets: [] };
  const upMin = (m.uptimeMs ?? 0) / 60000;
  const rpm = upMin > 0 ? (m.requests ?? 0) / upMin : 0;
  const errPct = (m.errorRate ?? 0) * 100;
  const red = document.createElement("div");
  red.className = "tl-stats";
  red.append(
    obsStat("Requests", (m.requests ?? 0).toLocaleString()),
    obsStat("Throughput", `${rpm.toFixed(1)}/min`),
    obsStat("Success rate", `${(100 - errPct).toFixed(1)}%`),
    obsStat("Error rate", `${errPct.toFixed(1)}%`),
    obsStat("Uptime", obsDuration(m.uptimeMs ?? 0)),
    obsStat("Memory (RSS)", obsBytes(m.rssBytes ?? 0)),
  );
  wrap.appendChild(obsSection("Server health (since boot)", red));

  // --- Latency KPIs + histogram --------------------------------------------
  const latRow = document.createElement("div");
  latRow.className = "tl-stats";
  latRow.append(
    obsStat("Avg", `${(lat.avgMs ?? 0).toFixed(1)} ms`),
    obsStat("p50", `${lat.p50Ms ?? 0} ms`),
    obsStat("p95", `${lat.p95Ms ?? 0} ms`),
    obsStat("p99", `${lat.p99Ms ?? 0} ms`),
    obsStat("Max", `${Math.round(lat.maxMs ?? 0)} ms`),
  );
  const latWrap = document.createElement("div");
  latWrap.append(latRow, renderLatencyHistogram(lat));
  wrap.appendChild(obsSection("Request latency", latWrap));

  // --- Status distribution --------------------------------------------------
  wrap.appendChild(obsSection("Status codes", renderStatusBar(m.byClass || {}, m.requests ?? 0)));

  // --- Requests by route (KPI table, drillable) -----------------------------
  if (m.byRoute && Object.keys(m.byRoute).length) {
    wrap.appendChild(obsSection("Requests by route — click a row to drill in", renderRouteTable(m.byRoute, m.requests ?? 0)));
  }

  // --- Event counters -------------------------------------------------------
  const counters = m.counters || {};
  const counterDefs = [
    ["fschange", "File changes"],
    ["reveal", "Secret reveals"],
    ["write", "Writes"],
    ["restore", "Restores"],
    ["audit", "Audit events"],
    ["error", "Errors"],
  ];
  const cRow = document.createElement("div");
  cRow.className = "tl-stats";
  for (const [key, label] of counterDefs) {
    const n = counters[key] ?? 0;
    // Counters that map to a journal kind are drillable.
    const kindMap = { fschange: "fschange", reveal: "audit", write: "audit", restore: "audit", audit: "audit", error: "error" };
    const onClick = n > 0 && kindMap[key]
      ? () => obsDrillFetch(`${label} — recent`, { kind: kindMap[key], limit: "500" })
      : undefined;
    cRow.appendChild(obsStat(label, n.toLocaleString(), undefined, onClick));
  }
  wrap.appendChild(obsSection("Activity counters (since boot)", cRow));

  // --- History charts (reused from the activity timeline) -------------------
  // Clicking a heatmap day drills into that day's events.
  const onDay = (label) => {
    const [y, mo, d] = label.split("-").map(Number);
    const from = Date.UTC(y, mo - 1, d);
    obsDrillFetch(`Events on ${label} (UTC)`, { from: String(from), to: String(from + 86_400_000 - 1), limit: "1000" });
  };
  const heat = document.createElement("div");
  heat.appendChild(renderHeatmap(agg.days, onDay));
  heat.appendChild(renderHeatmapLegend(agg.days));
  wrap.appendChild(obsSection(`Events per day · ${agg.total.toLocaleString()} in window · click a day`, heat));
  wrap.appendChild(obsSection("Events by hour of day (UTC)", renderHourChart(agg.byHour)));

  // --- Event kinds (drillable) ----------------------------------------------
  const kinds = Object.entries(agg.byKind).sort((a, b) => b[1] - a[1]);
  if (kinds.length) {
    const maxK = kinds[0][1] || 1;
    const list = document.createElement("div");
    list.className = "obs-bars";
    for (const [kind, count] of kinds) {
      const row = document.createElement("div");
      row.className = "obs-bar-row obs-bar-click";
      row.title = `Drill into ${kind} events`;
      row.addEventListener("click", () => obsDrillFetch(`Kind · ${kind}`, { kind, limit: "1000" }));
      const name = document.createElement("span");
      name.className = "obs-bar-label";
      name.textContent = kind;
      const track = document.createElement("span");
      track.className = "obs-bar-track";
      const fill = document.createElement("span");
      fill.className = `obs-bar-fill kind-${escapeHtml(kind)}`;
      fill.style.width = `${Math.max(3, (count / maxK) * 100)}%`;
      track.appendChild(fill);
      const val = document.createElement("span");
      val.className = "obs-bar-value";
      val.textContent = count.toLocaleString();
      row.append(name, track, val);
      list.appendChild(row);
    }
    wrap.appendChild(obsSection("Event kinds — click to drill in", list));
  }

  // --- Most active paths ----------------------------------------------------
  if (agg.topPaths.length) {
    wrap.appendChild(obsSection("Most active paths", renderObsPathList(agg.topPaths)));
  }

  // --- Recent events --------------------------------------------------------
  if (data.recent && data.recent.length) {
    const list = document.createElement("div");
    list.className = "obs-events";
    for (const ev of data.recent) list.appendChild(renderObsEventRow(ev, true));
    wrap.appendChild(obsSection("Recent events", list));
  }

  // --- Journal stats --------------------------------------------------------
  const j = data.journal || {};
  const jRow = document.createElement("div");
  jRow.className = "tl-stats";
  jRow.append(
    obsStat("Journal size", obsBytes(j.bytes ?? 0)),
    obsStat("All-time events", (j.events ?? 0).toLocaleString()),
    obsStat("Oldest", j.oldestMs ? obsTime(j.oldestMs) : "—"),
    obsStat("Newest", j.newestMs ? obsTime(j.newestMs) : "—"),
  );
  wrap.appendChild(obsSection("Journal", jRow));

  // --- Footer ---------------------------------------------------------------
  const note = document.createElement("div");
  note.className = "tl-note";
  note.textContent = `Persistent journal: ${data.journalDir || "—"} · metadata only (paths, kinds), never file contents.`;
  wrap.appendChild(note);

  return wrap;
}

// Wire up the observability overlay (mirrors setupTimeline).
(function setupObservability() {
  const overlay = /** @type {HTMLElement} */ (document.getElementById("obs-overlay"));
  const toggleBtn = /** @type {HTMLElement} */ (document.getElementById("obs-toggle"));
  const closeBtn = /** @type {HTMLElement} */ (document.getElementById("obs-close"));
  const refreshBtn = /** @type {HTMLElement} */ (document.getElementById("obs-refresh"));
  const daysSelect = /** @type {HTMLSelectElement} */ (document.getElementById("obs-days"));
  if (!overlay || !toggleBtn || !closeBtn || !daysSelect) return;

  const days = () => parseInt(daysSelect.value, 10) || 30;
  function open() {
    overlay.classList.remove("hidden");
    toggleBtn.setAttribute("aria-expanded", "true");
    loadObservability(days());
  }
  function close() {
    overlay.classList.add("hidden");
    toggleBtn.setAttribute("aria-expanded", "false");
  }
  toggleBtn.addEventListener("click", () => {
    if (overlay.classList.contains("hidden")) open();
    else close();
  });
  closeBtn.addEventListener("click", close);
  if (refreshBtn) refreshBtn.addEventListener("click", () => loadObservability(days()));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.classList.contains("hidden")) close();
  });
  daysSelect.addEventListener("change", () => loadObservability(days()));
})();

init();
