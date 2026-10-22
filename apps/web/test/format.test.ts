import { describe, expect, it } from "vitest";
import { showDate, showMoney, showValue } from "../src/lib/format";

describe("display rules", () => {
  it("shows dates as Tue 4 Nov 2026, never 04/11/26", () => {
    expect(showDate("2026-11-03")).toBe("Tue 3 Nov 2026");
    expect(showDate("09/10/2026")).toBe("Fri 9 Oct 2026 (written 09/10/2026)");
  });
  it("shows money with currency and the GST split", () => {
    expect(showMoney("1320.00", "120.00")).toBe("$1,320.00 AUD (incl. $120.00 GST)");
    expect(showValue({ type: "amount", field: "gst_amount" }, "120.00")).toBe("$120.00 GST");
  });
});
