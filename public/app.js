// Rooms Agent Pay front end: no framework. PayPal JS SDK for funding, AG Grid Community for the ledger.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (c, cur = "USD") => (cur === "USD" ? "$" : "") + (Number(c || 0) / 100).toFixed(2) + (cur === "USD" ? "" : " " + cur);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let CFG = null, STATE = null, grid = null, running = false, ppLoaded = null;

const NAMES = { you: "You", "rooms-ai": "Rooms AI · host", paypal: "PayPal" };
const EXAMPLES = [
  "Write a launch announcement for a neighbourhood bike-repair pop-up, plus a simple poster layout.",
  "Plan a one-page landing page for a weekend coding workshop for teens: research, layout and copy.",
  "Draft a friendly email inviting local cafés to stock our oat-milk cold brew, with 3 key facts.",
];

async function api(method, path, body) {
  const r = await fetch("/api" + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || j.error || r.statusText), { code: j.error, status: r.status });
  return j;
}

async function boot() {
  CFG = await api("GET", "/config");
  for (const a of CFG.agents) NAMES[a.slug] = a.name;
  const id = new URLSearchParams(location.search).get("room");
  if (id) return openRoom(id);
  showStart();
}

function showStart() {
  $("#room").hidden = true; $("#start").hidden = false;
  $("#catalog").innerHTML = CFG.agents.map((a) => `<li><span class="av av-${a.slug}">${esc(a.name[0])}</span><div><b>${esc(a.name)}</b><span class="muted"> · ${money(a.priceCents)} per job</span><br><small>${esc(a.skill)}</small></div></li>`).join("");
  $("#examples").innerHTML = EXAMPLES.map((e, i) => `<button type="button" class="chip" data-i="${i}">${esc(e.split(":")[0].split(",")[0].slice(0, 48))}…</button>`).join("");
  $("#examples").onclick = (ev) => { const b = ev.target.closest(".chip"); if (b) $("#task").value = EXAMPLES[+b.dataset.i]; };
  const cap = $("#cap"), auto = $("#auto");
  const sync = () => { $("#cap-out").textContent = money(cap.value * 100); $("#auto-out").textContent = money(auto.value * 100); };
  cap.oninput = auto.oninput = sync; sync();
  $("#new-room").onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $("#open-btn"); btn.disabled = true; btn.textContent = "Rooms AI is planning the hires…"; $("#start-err").hidden = true;
    try {
      const s = await api("POST", "/rooms", { task: $("#task").value, cap_cents: cap.value * 100, auto_approve_cents: auto.value * 100 });
      history.pushState({}, "", "?room=" + s.room.id);
      $("#start").hidden = true; render(s);
    } catch (e) { $("#start-err").textContent = e.message; $("#start-err").hidden = false; }
    finally { btn.disabled = false; btn.textContent = "Open the room"; }
  };
}

async function openRoom(id) {
  try {
    render(await api("GET", `/rooms/${id}`));
    if (STATE.room.funded_cents > 0 && STATE.room.status !== "closed" && STATE.hires.some((h) => ["proposed", "approved"].includes(h.status))) runAgents();
  } catch { history.replaceState({}, "", "/"); showStart(); }
}

function render(s) {
  STATE = s;
  const { room, messages, hires, ledger } = s;
  $("#start").hidden = true; $("#room").hidden = false;
  $("#room-task").textContent = room.task;
  const st = { planning: "Planning", awaiting_funds: "Waiting for funds", funded: "Funded", working: "Agents working", done: "Jobs done", closed: "Closed" }[room.status] || room.status;
  $("#room-status").textContent = st; $("#room-status").dataset.s = room.status;

  const cur = room.currency;
  $("#b-available").textContent = money(room.available_cents, cur);
  $("#b-cap").textContent = money(room.cap_cents, cur);
  $("#b-funded").textContent = money(room.funded_cents, cur);
  $("#b-spent").textContent = money(room.spent_cents, cur);
  $("#b-refunded").textContent = money(room.refunded_cents, cur);
  $("#bar-spent").style.width = (100 * room.spent_cents / room.cap_cents) + "%";
  $("#bar-refund").style.width = (100 * room.refunded_cents / room.cap_cents) + "%";

  const ol = $("#messages");
  const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 80;
  ol.innerHTML = messages.map(msgHtml).join("");
  if (atBottom || running) ol.scrollTop = ol.scrollHeight;

  $("#hires").innerHTML = hires.map((h) => `<li><span class="av av-${h.agent}">${esc((NAMES[h.agent] || h.agent)[0])}</span><div><b>${esc(h.title)}</b><br><small class="muted">${esc(NAMES[h.agent] || h.agent)} · ${money(h.price_cents, cur)}</small></div><span class="pill" data-s="${h.status}">${hireLabel(h.status)}</span></li>`).join("") || `<li class="muted">No hires planned.</li>`;

  const waitingApproval = hires.find((h) => h.status === "needs_approval");
  $("#act-fund").hidden = room.funded_cents > 0 || room.status === "closed";
  $("#fund-amount").textContent = money(room.cap_cents, cur);
  $("#act-approve").hidden = !(room.funded_cents > 0 && waitingApproval && !running);
  if (waitingApproval) {
    $("#approve-text").innerHTML = `Rooms AI wants to hire <b>${esc(NAMES[waitingApproval.agent])}</b> for “${esc(waitingApproval.title)}” at <b>${money(waitingApproval.price_cents, cur)}</b>, above your ${money(room.auto_approve_cents, cur)} approval line.`;
    $("#approve-yes").onclick = () => decide(waitingApproval.id, true);
    $("#approve-no").onclick = () => decide(waitingApproval.id, false);
  }
  const left = room.available_cents;
  $("#act-close").hidden = !(room.funded_cents > 0 && room.status !== "closed" && !running && !waitingApproval);
  $("#close-text").textContent = left > 0 ? `Close the room to refund the unspent ${money(left, cur)} to your PayPal.` : "Close the room.";

  renderGrid(ledger, cur);
  if (!$("#act-fund").hidden) mountPayPal();
}

const hireLabel = (s) => ({ proposed: "Planned", needs_approval: "Needs OK", approved: "Approved", working: "Working", paid: "Paid", rejected: "Rejected", declined: "Declined", failed: "Failed" }[s] || s);

function msgHtml(m) {
  const who = NAMES[m.author] || m.author;
  const t = new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (m.kind === "receipt") {
    const x = m.meta || {};
    const ref = x.capture_id || x.payout_batch_id || x.refund_id || x.debug_id || "";
    const amt = x.amount_cents != null ? money(x.amount_cents, STATE.room.currency) : "";
    const label = { funding: "Funding captured", payout: "Agent paid", refund: "Refund issued", payout_failed: "Payout failed" }[x.type] || "Receipt";
    return `<li class="msg receipt" data-type="${esc(x.type)}"><div class="rc-head"><span class="pp">PayPal</span><b>${label}</b><span class="amt">${amt}</span></div><p>${esc(m.body)}</p>${ref ? `<code class="ref">${esc(ref)}</code>` : ""}${x.status ? ` <span class="pill" data-s="${esc(String(x.status).toLowerCase())}">${esc(x.status)}</span>` : ""}<time>${t}</time></li>`;
  }
  const cls = m.author === "you" ? "me" : m.author === "rooms-ai" ? "host" : "agent";
  const extra = m.kind === "verdict" ? (m.meta?.pass ? " ok" : " bad") : "";
  return `<li class="msg ${cls} k-${m.kind}${extra}"><span class="av av-${esc(m.author)}">${esc(who[0])}</span><div class="bubble"><div class="meta"><b>${esc(who)}</b>${m.kind === "deliverable" ? ' <span class="tag">delivery</span>' : ""}${m.kind === "plan" ? ' <span class="tag">plan</span>' : ""}<time>${t}</time></div><div class="body">${esc(m.body).replace(/\n/g, "<br>")}</div></div></li>`;
}

function renderGrid(rows, cur) {
  if (!window.agGrid) { setTimeout(() => renderGrid(STATE.ledger, cur), 300); return; }
  const data = rows.map((r) => ({ ...r, amount: r.amount_cents / 100 }));
  const total = data.reduce((s, r) => s + r.amount_cents, 0);
  const pinned = [{ type: "Balance held for room", amount: total / 100, party: "", paypal_ref: "", status: "", note: "" }];
  if (grid) { grid.setGridOption("rowData", data); grid.setGridOption("pinnedBottomRowData", pinned); return; }
  const theme = agGrid.themeQuartz.withParams({
    fontFamily: "inherit", accentColor: "#2f5d50", backgroundColor: "#fbfaf7", foregroundColor: "#1f2a2e",
    headerBackgroundColor: "#f0eee8", borderColor: "#e2dfd6", rowHoverColor: "#f2f0ea", wrapperBorderRadius: 10, fontSize: 13,
  });
  grid = agGrid.createGrid($("#grid"), {
    theme, rowData: data, pinnedBottomRowData: pinned, domLayout: "autoHeight", animateRows: true,
    defaultColDef: { sortable: true, resizable: true, filter: true, flex: 1, minWidth: 110 },
    columnDefs: [
      { field: "ts", headerName: "Time", maxWidth: 120, valueFormatter: (p) => p.value ? new Date(p.value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "" },
      { field: "type", headerName: "Type", cellRenderer: (p) => p.node.rowPinned ? `<b>${p.value}</b>` : `<span class="lt lt-${p.value}">${{ funding: "Funding", payout: "Agent payout", platform_fee: "Room fee", refund: "Refund" }[p.value] || p.value}</span>` },
      { field: "party", headerName: "Party", minWidth: 200 },
      { field: "amount", headerName: `Amount (${cur})`, type: "rightAligned", cellClass: (p) => p.value < 0 ? "neg" : "pos", valueFormatter: (p) => (p.value < 0 ? "−" : "+") + "$" + Math.abs(p.value).toFixed(2) },
      { field: "paypal_ref", headerName: "PayPal reference", minWidth: 170 },
      { field: "status", headerName: "Status", cellRenderer: (p) => p.value ? `<span class="pill" data-s="${String(p.value).toLowerCase()}">${p.value}</span>` : "" },
      { field: "note", headerName: "Note", minWidth: 180 },
    ],
  });
}

function mountPayPal() {
  if (!CFG.paypalClientId) { $("#paypal-buttons").innerHTML = `<p class="err">PayPal is not configured on this server.</p>`; return; }
  if ($("#paypal-buttons").dataset.room === STATE.room.id) return;
  $("#paypal-buttons").dataset.room = STATE.room.id;
  ppLoaded = ppLoaded || new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(CFG.paypalClientId)}&currency=${CFG.currency}&intent=capture&components=buttons&disable-funding=paylater,venmo`;
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
  ppLoaded.then(() => {
    $("#paypal-buttons").innerHTML = "";
    paypal.Buttons({
      style: { layout: "vertical", color: "black", shape: "rect", label: "pay", height: 42 },
      createOrder: async () => (await api("POST", `/rooms/${STATE.room.id}/fund/order`)).orderID,
      onApprove: async (data) => {
        render(await api("POST", `/rooms/${STATE.room.id}/fund/capture`, { orderID: data.orderID }));
        runAgents();
      },
      onError: (err) => { $("#paypal-buttons").insertAdjacentHTML("beforeend", `<p class="err">PayPal: ${esc(err?.message || err)}</p>`); },
    }).render("#paypal-buttons");
  }).catch(() => { $("#paypal-buttons").innerHTML = `<p class="err">Couldn't load PayPal.</p>`; });
}

async function runAgents() {
  if (running) return;
  running = true;
  try {
    for (let i = 0; i < 8; i++) {
      const next = STATE.hires.find((h) => ["proposed", "approved"].includes(h.status));
      if (next) typing(`${NAMES[next.agent]} is working · Rooms AI will verify before paying`);
      const s = await api("POST", `/rooms/${STATE.room.id}/step`);
      typing(null); render(s);
      if (s.waiting) break;
      await sleep(400);
    }
    await sleep(1500);
    const s = await api("POST", `/rooms/${STATE.room.id}/payouts/refresh`);
    running = false; render(s);
  } catch (e) { typing(null); alertErr(e); }
  finally { running = false; render(STATE); }
}

async function decide(hid, yes) {
  try { render(await api("POST", `/rooms/${STATE.room.id}/hires/${hid}/${yes ? "approve" : "decline"}`)); runAgents(); }
  catch (e) { alertErr(e); }
}

function typing(text) { const t = $("#typing"); t.hidden = !text; t.innerHTML = text ? `<span class="dots"><i></i><i></i><i></i></span>${esc(text)}` : ""; }
function alertErr(e) { $("#messages").insertAdjacentHTML("beforeend", `<li class="msg sys err">${esc(e.message)}</li>`); }

$("#close-btn")?.addEventListener("click", async () => {
  const b = $("#close-btn"); b.disabled = true;
  try { render(await api("POST", `/rooms/${STATE.room.id}/close`)); } catch (e) { alertErr(e); } finally { b.disabled = false; }
});
$("#refresh-btn")?.addEventListener("click", async () => { try { render(await api("POST", `/rooms/${STATE.room.id}/payouts/refresh`)); } catch (e) { alertErr(e); } });
window.addEventListener("popstate", () => location.reload());
boot();
