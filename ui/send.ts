// Review form for a reward batch. Rendered for review_rewards results.
// Nothing is sent until the user clicks Send twice (click, then confirm).
import { $, createApp, el, money, resultText } from "./common";

type Recipient = { name?: string; email?: string; phone?: string; amount: number };
type Draft = {
  recipients: Recipient[];
  currency_code?: string;
  campaign_id?: string;
  products?: string[];
  funding_source_id: string;
  delivery_method: "EMAIL" | "PHONE" | "LINK";
  deliver_at?: string;
  language?: string;
  sender_name?: string;
  subject_line?: string;
  message?: string;
};
type Funding = { id: string; label: string; method: string };
type Campaign = { id: string; name: string };
type Payload = {
  environment: string;
  draft_id: string;
  draft: Draft;
  errors: string[];
  warnings: string[];
  funding_sources: Funding[];
  campaigns: Campaign[];
};
type SendRow = {
  index: number;
  recipient: string;
  amount: number;
  outcome: string;
  order_id?: string;
  order_status?: string;
  link?: string;
  error?: string;
};

const { app, connect } = createApp("tremendous-send");
let payload: Payload;
let draft: Draft;
let armed: ReturnType<typeof setTimeout> | null = null;

const input = (id: string) => $<HTMLInputElement>(id);

function readForm(): Draft {
  const camp = $<HTMLSelectElement>("campaign").value;
  const opt = (v: string) => v.trim() || undefined;
  return {
    ...draft,
    campaign_id: camp.startsWith("products:") ? undefined : opt(camp),
    products: camp.startsWith("products:") ? draft.products : undefined,
    funding_source_id: $<HTMLSelectElement>("funding").value,
    delivery_method: $<HTMLSelectElement>("delivery").value as Draft["delivery_method"],
    currency_code: opt(input("currency").value.toUpperCase()),
    sender_name: opt(input("sender_name").value),
    subject_line: opt(input("subject_line").value),
    message: opt($<HTMLTextAreaElement>("message").value),
    deliver_at: opt(input("deliver_at").value),
    recipients: draft.recipients
      .map((r) => ({
        name: r.name?.trim() || undefined,
        email: r.email?.trim() || undefined,
        phone: r.phone?.trim() || undefined,
        amount: Number(r.amount),
      }))
      .filter((r) => r.name || r.email || r.phone),
  };
}

function problems(d: Draft): string[] {
  const out: string[] = [];
  if (!d.campaign_id && !d.products?.length) out.push("Choose a campaign.");
  if (!d.recipients.length) out.push("Add at least one recipient.");
  d.recipients.forEach((r, i) => {
    const who = r.email ?? r.phone ?? r.name ?? `#${i + 1}`;
    if (!(r.amount > 0)) out.push(`${who}: amount must be more than 0.`);
    if (d.delivery_method === "EMAIL" && !r.email) out.push(`${who}: email is required.`);
    if (d.delivery_method === "PHONE" && !r.phone) out.push(`${who}: phone is required.`);
  });
  return out;
}

function disarm() {
  if (armed) clearTimeout(armed);
  armed = null;
}

function refresh() {
  disarm();
  const d = readForm();
  const total = Math.round(d.recipients.reduce((s, r) => s + (r.amount || 0), 0) * 100) / 100;
  $("total").textContent = `${d.recipients.length} reward(s) · ${money(total, d.currency_code ?? "")}`;
  const p = problems(d);
  $("problems").replaceChildren(
    ...p.map((t) => el("div", { className: "msg error", textContent: t })),
    ...payload.warnings.map((t) => el("div", { className: "msg warn", textContent: t })),
  );
  const btn = $<HTMLButtonElement>("send");
  btn.disabled = p.length > 0;
  btn.textContent = `Send ${money(total, d.currency_code ?? "")}`;
}

function renderRecipients() {
  const phone = $<HTMLSelectElement>("delivery").value === "PHONE";
  const t = $("recipients");
  t.replaceChildren(
    el("tr", {}, ...["Name", phone ? "Phone" : "Email", "Amount", ""].map((h) => el("th", { textContent: h }))),
  );
  draft.recipients.forEach((r, i) => {
    const field = (key: "name" | "email" | "phone", type = "text") => {
      const f = el("input", { type, value: (r[key] as string | undefined) ?? "" });
      f.style.width = "100%";
      f.oninput = () => {
        r[key] = f.value;
        refresh();
      };
      return f;
    };
    const amount = el("input", { type: "number", min: "0", step: "0.01", value: String(r.amount ?? "") });
    amount.oninput = () => {
      r.amount = Number(amount.value);
      refresh();
    };
    const del = el("button", { type: "button", className: "link", textContent: "Remove" });
    del.onclick = () => {
      draft.recipients.splice(i, 1);
      renderRecipients();
    };
    t.append(
      el(
        "tr",
        {},
        el("td", {}, field("name")),
        el("td", {}, phone ? field("phone", "tel") : field("email", "email")),
        el("td", { className: "num" }, amount),
        el("td", {}, del),
      ),
    );
  });
  refresh();
}

function showResults(rows: SendRow[], text: string) {
  $("form").hidden = true;
  $("results").hidden = false;
  $("summary").textContent = text.split("\n")[0];
  $("result-table").replaceChildren(
    el("tr", {}, ...["Recipient", "Amount", "Result", "Order"].map((h) => el("th", { textContent: h }))),
    ...rows.map((r) =>
      el(
        "tr",
        {},
        el("td", { textContent: r.recipient }),
        el("td", { className: "num", textContent: money(r.amount, draft.currency_code ?? "") }),
        el(
          "td",
          {},
          el("span", { className: `pill ${r.outcome}`, textContent: r.outcome.replace("_", " ") }),
          r.error ? el("div", { className: "sub", textContent: r.error }) : null,
        ),
        el("td", { className: "sub", textContent: r.order_id ? `${r.order_id} · ${r.order_status}` : "" }),
      ),
    ),
  );
}

async function send() {
  const btn = $<HTMLButtonElement>("send");
  const d = readForm();
  if (!armed) {
    // First click arms the button; the second click within 5 s sends.
    btn.textContent = `Confirm: send to ${d.recipients.length} recipient(s) (${payload.environment})`;
    armed = setTimeout(refresh, 5000);
    return;
  }
  disarm();
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const res = await app.callServerTool({ name: "send_rewards", arguments: { ...d, draft_id: payload.draft_id } });
    const sc = res.structuredContent as { rows?: SendRow[] } | undefined;
    if (sc?.rows) {
      showResults(sc.rows, resultText(res));
      await app.updateModelContext({
        content: [
          { type: "text", text: `The user sent draft ${payload.draft_id} from the form. Result:\n${resultText(res)}` },
        ],
      });
    } else {
      $("problems").replaceChildren(
        el("div", { className: "msg error", textContent: resultText(res) || "Send failed." }),
      );
      refresh();
    }
  } catch (e) {
    $("problems").replaceChildren(
      el("div", {
        className: "msg error",
        textContent: `Send failed: ${(e as Error).message}. Sending again with the same draft is safe (no double payment).`,
      }),
    );
    btn.disabled = false;
    btn.textContent = "Retry send";
  }
}

app.ontoolresult = (params) => {
  if (params.isError) {
    $("loading").textContent = resultText(params);
    return;
  }
  const p = params.structuredContent as Payload | undefined;
  if (!p?.draft) return;
  payload = p;
  draft = structuredClone(p.draft);
  $("env").textContent = p.environment;
  $("env").className = `env ${p.environment}`;
  $("draft").textContent = `draft ${p.draft_id}`;

  const camp = $<HTMLSelectElement>("campaign");
  camp.replaceChildren(
    el("option", { value: "", textContent: "Choose…" }),
    ...(draft.products?.length
      ? [
          el("option", {
            value: `products:${draft.products.join(",")}`,
            textContent: `Products: ${draft.products.join(", ")}`,
          }),
        ]
      : []),
    ...p.campaigns.map((c) => el("option", { value: c.id, textContent: c.name })),
  );
  camp.value = draft.campaign_id ?? (draft.products?.length ? `products:${draft.products.join(",")}` : "");

  const fund = $<HTMLSelectElement>("funding");
  const known = new Set(p.funding_sources.map((f) => f.id));
  fund.replaceChildren(
    ...(known.has(draft.funding_source_id)
      ? []
      : [el("option", { value: draft.funding_source_id, textContent: draft.funding_source_id })]),
    ...p.funding_sources.map((f) => el("option", { value: f.id, textContent: f.label })),
  );
  fund.value = draft.funding_source_id;

  $<HTMLSelectElement>("delivery").value = draft.delivery_method;
  input("currency").value = draft.currency_code ?? "";
  input("sender_name").value = draft.sender_name ?? "";
  input("subject_line").value = draft.subject_line ?? "";
  $<HTMLTextAreaElement>("message").value = draft.message ?? "";
  input("deliver_at").value = draft.deliver_at ?? "";

  $("loading").hidden = true;
  $("form").hidden = false;
  renderRecipients();
};

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  void send();
});
$("form").addEventListener("change", (e) => {
  if ((e.target as HTMLElement).id === "delivery") renderRecipients();
  else refresh();
});
$("add").onclick = () => {
  draft.recipients.push({ amount: draft.recipients.at(-1)?.amount ?? 0 });
  renderRecipients();
};

await connect();
