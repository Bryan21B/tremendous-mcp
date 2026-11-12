import { describe, expect, it } from "vitest";
import { queryRewards } from "../src/rewards-query.js";
import { fakeApi, fakeClient, makeRewards } from "./fake-api.js";

describe("queryRewards", () => {
  it("pages GET /rewards by 500 and filters by email", async () => {
    const api = fakeApi(makeRewards(1200));
    const r = await queryRewards(fakeClient(api), { email: "PERSON1@" });
    expect(api.calls.filter((c) => c.path === "/rewards").map((c) => c.query.offset)).toEqual(["0", "500", "1000"]);
    expect(r.rows).toHaveLength(300);
    expect(r.recipients).toHaveLength(1);
    expect(r.recipients[0].rewards).toBe(300);
    expect(r.truncated).toBe(false);
  });

  it("stops at max_scan and returns next_offset", async () => {
    const api = fakeApi(makeRewards(1200));
    const r = await queryRewards(fakeClient(api), { max_scan: 600 });
    expect(r.scanned).toBe(600);
    expect(r.truncated).toBe(true);
    expect(r.next_offset).toBe(600);
    const more = await queryRewards(fakeClient(api), { max_scan: 600, offset: 600 });
    expect(more.scanned).toBe(600);
    expect(more.truncated).toBe(false);
  });

  it("uses GET /orders with created_at filters for a date range", async () => {
    const api = fakeApi(makeRewards(48));
    const r = await queryRewards(fakeClient(api), { since: "2026-10-31T12:00:00.000Z" });
    const call = api.calls.find((c) => c.path === "/orders")!;
    expect(call.query["created_at[gte]"]).toBe("2026-10-31T12:00:00.000Z");
    expect(r.source).toBe("orders");
    expect(r.rows.every((x) => x.created_at! >= "2026-10-31T12:00:00.000Z")).toBe(true);
    expect(r.rows[0].order_status).toBe("EXECUTED");
  });

  it("filters by delivery status and totals per currency", async () => {
    const r = await queryRewards(fakeClient(fakeApi(makeRewards(30))), { delivery_status: "FAILED" });
    expect(r.rows.map((x) => x.id)).toEqual(["R000000", "R000010", "R000020"]);
    expect(r.totals).toEqual({ EUR: 33 }); // 10 + 11 + 12
  });
});
