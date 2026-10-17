import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import { isBlockedAddress } from "../src/collector/url-safety.ts";
import { parseRetryAfter } from "../src/collector/http.ts";
import { env, versioned, type TestEnv } from "./helpers.ts";

let e: TestEnv | undefined;
afterEach(async () => {
  await e?.close();
  e = undefined;
});

describe("URL safety", () => {
  test.each([
    ["127.0.0.1", true], ["10.1.2.3", true], ["172.20.0.1", true], ["192.168.1.1", true], ["169.254.169.254", true],
    ["100.64.0.1", true], ["0.0.0.0", true], ["224.0.0.1", true], ["::1", true], ["fe80::1", true], ["fd00::1", true],
    ["::ffff:10.0.0.1", true], ["64:ff9b::a00:1", true], ["8.8.8.8", false], ["172.32.0.1", false], ["2606:4700::1111", false],
  ])("%s blocked=%s", (ip, blocked) => {
    expect(isBlockedAddress(ip)).toBe(blocked);
  });

  test("private target is blocked unless allow-listed", async () => {
    e = await env({ allowHosts: [] });
    e.route("/p", versioned("text/markdown", "x").handler);
    expect((await e.collector.check(e.spec("/p", { format: "markdown" }))).outcome).toMatchObject({ failure: "blocked_url" });
  });

  test("redirect to a blocked address is refused at the hop", async () => {
    e = await env();
    e.route("/r", (_q, res) => void res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end());
    expect((await e.collector.check(e.spec("/r", { format: "markdown" }))).outcome).toMatchObject({ failure: "blocked_url" });
  });

  test("non-http scheme via redirect is refused", async () => {
    e = await env();
    e.route("/r", (_q, res) => void res.writeHead(301, { location: "file:///etc/passwd" }).end());
    expect((await e.collector.check(e.spec("/r", { format: "markdown" }))).outcome).toMatchObject({ failure: "blocked_url" });
  });
});

describe("redirects", () => {
  test("followed, with final URL reported", async () => {
    e = await env();
    e.route("/old", (_q, res) => void res.writeHead(301, { location: "/new" }).end());
    e.route("/new", versioned("text/markdown", "# moved\n").handler);
    const r = await e.collector.check(e.spec("/old", { format: "markdown" }));
    expect(r.outcome.status).toBe("first_seen");
    expect(r.finalUrl).toBe(`${e.base}/new`);
  });

  test("loop ends as too_many_redirects", async () => {
    e = await env();
    e.route("/a", (_q, res) => void res.writeHead(302, { location: "/b" }).end());
    e.route("/b", (_q, res) => void res.writeHead(302, { location: "/a" }).end());
    expect((await e.collector.check(e.spec("/a"))).outcome).toMatchObject({ failure: "too_many_redirects" });
  });

  test("redirect without Location is http_status", async () => {
    e = await env();
    e.route("/a", (_q, res) => void res.writeHead(302).end());
    expect((await e.collector.check(e.spec("/a"))).outcome).toMatchObject({ failure: "http_status", httpStatus: 302 });
  });
});

describe("limits and retries", () => {
  test("per-host concurrency is enforced", async () => {
    e = await env({ perHost: 2, concurrency: 20 });
    for (let i = 0; i < 10; i++) {
      e.route(`/s${i}`, async (_q, res) => {
        await sleep(40);
        res.writeHead(200, { "content-type": "text/markdown" }).end(`page ${i}`);
      });
    }
    const specs = Array.from({ length: 10 }, (_, i) => e!.spec(`/s${i}`, { format: "markdown" }));
    await e.collector.checkAll(specs);
    expect(e.inFlight.max).toBe(2);
  });

  test("timeouts are retried, then reported as timeout", async () => {
    e = await env({ timeoutMs: 100, retries: 1 });
    e.route("/slow", async (_q, res) => {
      await sleep(400);
      res.writeHead(200).end("late");
    });
    const r = await e.collector.check(e.spec("/slow", { format: "markdown" }));
    expect(r.outcome).toMatchObject({ failure: "timeout" });
    expect(e.requests.filter((q) => q.path === "/slow").length).toBe(2);
  });

  test("HTTP errors are not retried", async () => {
    e = await env();
    e.route("/e", (_q, res) => void res.writeHead(503).end());
    await e.collector.check(e.spec("/e"));
    expect(e.requests.filter((q) => q.path === "/e").length).toBe(1);
  });

  test("429 with a short Retry-After is honoured once", async () => {
    e = await env();
    let n = 0;
    e.route("/rl", (_q, res) => (n++ === 0 ? void res.writeHead(429, { "retry-after": "0" }).end() : void res.writeHead(200, { "content-type": "text/markdown" }).end("ok")));
    expect((await e.collector.check(e.spec("/rl", { format: "markdown" }))).outcome.status).toBe("first_seen");
    expect(n).toBe(2);
  });

  test("429 with a long Retry-After fails without waiting", async () => {
    e = await env({ maxRetryAfterMs: 1_000 });
    e.route("/rl", (_q, res) => void res.writeHead(429, { "retry-after": "3600" }).end());
    const t = performance.now();
    expect((await e.collector.check(e.spec("/rl"))).outcome).toMatchObject({ failure: "http_status", httpStatus: 429 });
    expect(performance.now() - t).toBeLessThan(1_000);
  });

  test("oversized body via Content-Length and via stream", async () => {
    e = await env({ maxBytes: 1_000 });
    e.route("/big", (_q, res) => void res.writeHead(200, { "content-type": "text/markdown", "content-length": "5000" }).end("x".repeat(5000)));
    e.route("/stream", (_q, res) => {
      res.writeHead(200, { "content-type": "text/markdown" });
      for (let i = 0; i < 10; i++) res.write("y".repeat(500));
      res.end();
    });
    expect((await e.collector.check(e.spec("/big", { format: "markdown" }))).outcome).toMatchObject({ failure: "too_large" });
    expect((await e.collector.check(e.spec("/stream", { format: "markdown" }))).outcome).toMatchObject({ failure: "too_large" });
  });

  test("connection refused is network", async () => {
    e = await env({ retries: 0 });
    const spec = { ...e.spec("/x"), url: "http://127.0.0.1:1/x" };
    expect((await e.collector.check(spec)).outcome).toMatchObject({ failure: "network" });
  });

  test("Retry-After parsing", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() + 2000).toUTCString())).toBeGreaterThan(0);
  });
});
