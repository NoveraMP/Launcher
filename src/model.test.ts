import { describe, it, expect } from "vitest";
import {
  normalizeAddress,
  emptyServer,
  filterServers,
  mergeServers,
  defaultFilters,
} from "./model";
describe("server catalog", () => {
  it("normalizes addresses without accepting URLs or invalid ports", () => {
    expect(normalizeAddress(" samp://LOCALHOST ")).toBe("localhost:7777");
    for (const value of [
      "https://example.com",
      "a:0",
      "a:65536",
      "a:77:88",
      "a;echo bad",
    ])
      expect(() => normalizeAddress(value)).toThrow();
  });
  it("preserves Arizona origin and per-server mode overrides with live statistics", () => {
    const server = {
      ...emptyServer("host:7777"),
      source: "arizona",
      arzMode: true,
    };
    const saved = { ...server, source: "custom", arzMode: false };
    const merged = mergeServers([server], [saved], {
      "host:7777": { online: 17, pingMs: 24 },
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      source: "arizona",
      arzMode: false,
      online: 17,
      pingMs: 24,
    });
  });
  it("combines search, full, empty, password and mode filters", () => {
    const full = {
      ...emptyServer("a:7777"),
      name: "Arizona Alpha",
      online: 10,
      maxplayers: 10,
      password: true,
      mode: "RP",
    };
    const free = { ...full, address: "b:7777", online: 3, password: false };
    expect(
      filterServers([full, free], {
        ...defaultFilters,
        search: "alpha",
        notFull: true,
        noPassword: true,
      }),
    ).toEqual([free]);
    expect(filterServers([free], { ...defaultFilters, mode: "DM" })).toEqual(
      [],
    );
  });
});
