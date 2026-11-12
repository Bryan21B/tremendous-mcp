declare const __APP_VERSION__: string;

import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string | null | undefined)[]) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

export const money = (n: number | undefined, cur = "") => (n === undefined ? "?" : `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`.trim());
export const fmtTotals = (t: Record<string, number>) => Object.entries(t).map(([c, v]) => money(v, c === "?" ? "" : c)).join(" + ") || "0";
export const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

/** Create the App, wire theming, and connect. Register handlers on the returned app BEFORE awaiting `connect`. */
export function createApp(name: string) {
  const app = new App({ name, version: __APP_VERSION__ });
  app.onhostcontextchanged = (ctx) => {
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  };
  const connect = async () => {
    await app.connect();
    const ctx = app.getHostContext();
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
    if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  };
  return { app, connect };
}

/** Text of the first content block, for error messages. */
export function resultText(r: { content?: unknown[] }): string {
  const first = (r.content ?? [])[0] as { type?: string; text?: string } | undefined;
  return first?.type === "text" ? (first.text ?? "") : "";
}
