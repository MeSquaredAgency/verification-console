import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatMoney,
  isValidAbn,
  locateQuote,
  matchName,
  parseDate,
  parseMoney,
  sameValue,
  sweepNumbersAndDates,
} from "../src";

describe("dates", () => {
  it("formats as Tue 4 Nov 2026", () => {
    expect(formatDate("2026-11-04")).toBe("Wed 4 Nov 2026");
    expect(formatDate("2026-11-03")).toBe("Tue 3 Nov 2026");
  });
  it("parses AU numeric dates day-first and flags ambiguity", () => {
    expect(parseDate("03/04/2026")).toEqual({ iso: "2026-04-03", ambiguous: true, statedWeekday: null });
    expect(parseDate("25/04/2026")?.ambiguous).toBe(false);
    expect(parseDate("Mon 3 Nov 2026")).toEqual({ iso: "2026-11-03", ambiguous: false, statedWeekday: 1 });
    expect(parseDate("31/02/2026")).toBeNull();
  });
});

describe("money", () => {
  it("parses and formats with GST split", () => {
    expect(parseMoney("$1,320.00")).toBe(132000);
    expect(parseMoney("1320")).toBe(132000);
    expect(parseMoney("abc")).toBeNull();
    expect(formatMoney(132000, 12000)).toBe("$1,320.00 AUD (incl. $120.00 GST)");
  });
});

describe("abn", () => {
  it("validates checksum", () => {
    expect(isValidAbn("51 824 753 556")).toBe(true);
    expect(isValidAbn("51 824 753 557")).toBe(false);
  });
});

describe("text", () => {
  it("locates quotes across whitespace changes", () => {
    const src = "Total due\n  $1,320.00 by Friday";
    expect(locateQuote(src, "Total due $1,320.00")).toEqual({ start: 0, end: 21 });
    expect(locateQuote(src, "Total due $1,330.00")).toBeNull();
  });
  it("sweeps every number and date", () => {
    const toks = sweepNumbersAndDates("Rent of $550.00 is due Tue 4 Nov 2026, ref INV-2231, unit 4.");
    expect(toks.map((t) => [t.kind, t.text])).toEqual([
      ["money", "$550.00"],
      ["date", "Tue 4 Nov 2026"],
      ["number", "INV-2231"],
      ["number", "4"],
    ]);
  });
  it("finds near-match names", () => {
    expect(matchName("Coopers Plumbing Pty Ltd", ["Cooper Plumbing Pty Ltd"]).kind).toBe("near");
    expect(matchName("Cooper Plumbing", ["Cooper Plumbing Pty Ltd"]).kind).toBe("exact");
  });
  it("compares values canonically", () => {
    expect(sameValue("amount", "$1,320.00", "1320")).toBe(true);
    expect(sameValue("date", "4/11/2026", "Wed 4 Nov 2026")).toBe(true);
  });
});
