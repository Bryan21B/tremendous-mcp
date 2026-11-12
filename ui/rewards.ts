// Rewards dashboard. Rendered for list_rewards results.
import { $, createApp, el, fmtDate, fmtTotals, money, resultText } from "./common";

type Row = {
  id: string;
  order_id?: string;
  created_at?: string;
  recipient_name?: string;
  recipient_email?: string;
  recipient_phone?: string;
  amount?: number;
  currency?: string;
  delivery_method?: string;
  delivery_status?: string;
  order_status?: string;
  campaign_id?: string | null;
};
type Payload = {
  environment: string;
  filters: Record<string, unknown>;
  rows: Row[];
  scanned: number;
  total_available: number;
  rows_omitted?: number;
  next_offset: number | null;
  truncated: boolean;
  source: string;
};

const STATUSES = ["ALL", "SUCCEEDED", "PENDING", "SCHEDULED", "FAILED"] as const;
const state = {
  rows: [] as Row[],
  filters: {} as Record<string, unknown>,
  status: "ALL" as string,
  search: "",
  byRecipient: true,
  scanned: 0,
  total: 0,
  next: null as number | null,
};

const { app, connect } = createApp("tremendous-rewards");

const who = (r: Row) => (r.recipient_email ?? r.recipient_phone ?? r.recipient_name ?? "unknown").toLowerCase();

function visibleRows(): Row[] {
  const q = state.search.trim().toLowerCase();
  return state.rows.filter(
    (r) =>
      (state.status === "ALL" || r.delivery_status === state.status) &&
      (!q ||
        `${r.recipient_name ?? ""} ${r.recipient_email ?? ""} ${r.recipient_phone ?? ""}`.toLowerCase().includes(q)),
  );
}

function totals(rows: Row[]) {
  const t: Record<string, number> = {};
  for (const r of rows)
    if (typeof r.amount === "number")
      t[r.currency ?? "?"] = Math.round(((t[r.currency ?? "?"] ?? 0) + r.amount) * 100) / 100;
  return t;
}

function notice(text: string, kind: "error" | "" = "") {
  const n = $("notice");
  n.textContent = text;
  n.className = `msg ${kind}`;
  n.hidden = !text;
}

async function act(tool: "resend_reward" | "cancel_reward", row: Row, btn: HTMLButtonElement) {
  btn.disabled = true;
  try {
    const res = await app.callServerTool({ name: tool, arguments: { id: row.id } });
    if (res.isError) {
      notice(resultText(res), "error");
      btn.disabled = false;
      return;
    }
    notice(resultText(res));
    if (tool === "cancel_reward") {
      state.rows = state.rows.filter((r) => r.id !== row.id);
      render();
    }
  } catch (e) {
    notice(`Action failed: ${(e as Error).message}`, "error");
    btn.disabled = false;
  }
}

function renderTable(rows: Row[]) {
  const table = $("table");
  table.replaceChildren();
  if (!rows.length) {
    table.append(el("tr", {}, el("td", { className: "sub", textContent: "No rewards match." })));
    return;
  }

  if (state.byRecipient) {
    const groups = new Map<string, Row[]>();
    for (const r of rows) groups.set(who(r), [...(groups.get(who(r)) ?? []), r]);
    table.append(
      el(
        "tr",
        {},
        ...["Recipient", "Rewards", "Total", "Last reward", "Status"].map((h) => el("th", { textContent: h })),
      ),
    );
    const sorted = [...groups.values()].sort((a, b) => (b[0].created_at ?? "").localeCompare(a[0].created_at ?? ""));
    for (const g of sorted) {
      const failed = g.filter((r) => r.delivery_status === "FAILED").length;
      const name = g.find((r) => r.recipient_name)?.recipient_name;
      const contact = g[0].recipient_email ?? g[0].recipient_phone ?? "";
      const tr = el(
        "tr",
        {},
        el(
          "td",
          {},
          el("div", { textContent: name ?? contact }),
          name ? el("div", { className: "sub", textContent: contact }) : null,
        ),
        el("td", { className: "num", textContent: String(g.length) }),
        el("td", { className: "num", textContent: fmtTotals(totals(g)) }),
        el("td", { className: "num", textContent: fmtDate(g[0].created_at) }),
        el(
          "td",
          {},
          failed
            ? el("span", { className: "pill FAILED", textContent: `${failed} failed` })
            : el("span", { className: "pill SUCCEEDED", textContent: "ok" }),
        ),
      );
      tr.style.cursor = "pointer";
      tr.title = "Show this recipient's rewards";
      tr.onclick = () => {
        state.search = contact || name || "";
        ($("search") as HTMLInputElement).value = state.search;
        state.byRecipient = false;
        render();
      };
      table.append(tr);
    }
    return;
  }

  table.append(
    el("tr", {}, ...["Recipient", "Amount", "Date", "Delivery", "", ""].map((h) => el("th", { textContent: h }))),
  );
  for (const r of rows) {
    const actions = el("td", { className: "num" });
    if (r.delivery_status === "FAILED") {
      const resend = el("button", { className: "link", type: "button", textContent: "Resend" });
      resend.onclick = () => act("resend_reward", r, resend);
      const cancel = el("button", { className: "link", type: "button", textContent: "Cancel" });
      cancel.onclick = () => act("cancel_reward", r, cancel);
      actions.append(resend, cancel);
    }
    table.append(
      el(
        "tr",
        {},
        el(
          "td",
          {},
          el("div", { textContent: r.recipient_name ?? r.recipient_email ?? r.recipient_phone ?? "?" }),
          el("div", {
            className: "sub",
            textContent: r.recipient_name ? (r.recipient_email ?? r.recipient_phone ?? "") : r.id,
          }),
        ),
        el("td", { className: "num", textContent: money(r.amount, r.currency) }),
        el("td", { className: "num", textContent: fmtDate(r.created_at) }),
        el(
          "td",
          {},
          el("span", { className: `pill ${r.delivery_status ?? ""}`, textContent: `${r.delivery_status ?? "?"}` }),
          el("span", {
            className: "sub",
            textContent: ` ${r.delivery_method ?? ""}${r.order_status && r.order_status !== "EXECUTED" ? ` · ${r.order_status}` : ""}`,
          }),
        ),
        el("td", { className: "sub", textContent: r.id }),
        actions,
      ),
    );
  }
}

function render() {
  const rows = visibleRows();
  $("s-rewards").textContent = String(rows.length);
  $("s-recipients").textContent = String(new Set(rows.map(who)).size);
  $("s-total").textContent = fmtTotals(totals(rows));
  $("s-failed").textContent = String(rows.filter((r) => r.delivery_status === "FAILED").length);
  $("mode").textContent = state.byRecipient ? "By recipient" : "All rewards";
  $("chips").replaceChildren(
    ...STATUSES.map((s) => {
      const b = el("button", {
        type: "button",
        className: `chip${state.status === s ? " on" : ""}`,
        textContent: s === "ALL" ? "All" : s.toLowerCase(),
      });
      b.onclick = () => {
        state.status = s;
        render();
      };
      return b;
    }),
  );
  $("scan").textContent =
    `Scanned ${state.scanned} of ${state.total}.${state.next !== null ? " Older rewards not loaded yet." : ""}`;
  $("more").hidden = state.next === null;
  renderTable(rows);
}

function load(p: Payload, append: boolean) {
  state.rows = append ? [...state.rows, ...p.rows] : p.rows;
  state.filters = p.filters ?? {};
  state.scanned = append ? state.scanned + p.scanned : p.scanned;
  state.total = p.total_available;
  state.next = p.truncated ? p.next_offset : null;
  const env = $("env");
  env.textContent = p.environment;
  env.className = `env ${p.environment}`;
  $("loading").hidden = true;
  $("main").hidden = false;
  if (p.rows_omitted)
    notice(`${p.rows_omitted} matching reward(s) not shown here (row limit). Narrow the filters to see them.`);
  render();
}

app.ontoolresult = (params) => {
  if (params.isError) {
    $("loading").textContent = resultText(params);
    return;
  }
  const p = params.structuredContent as Payload | undefined;
  if (p?.rows) load(p, false);
};

$("search").addEventListener("input", (e) => {
  state.search = (e.target as HTMLInputElement).value;
  render();
});
$("mode").onclick = () => {
  state.byRecipient = !state.byRecipient;
  render();
};
$("more").onclick = async () => {
  const btn = $("more") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    const res = await app.callServerTool({ name: "list_rewards", arguments: { ...state.filters, offset: state.next } });
    if (res.isError) notice(resultText(res), "error");
    else load(res.structuredContent as Payload, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Load more";
  }
};

await connect();
