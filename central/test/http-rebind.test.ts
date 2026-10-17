// DNS rebinding: a name that resolves to a public address for the check and to a private one for the connection is
// refused at the connection, because the socket's own lookup is the one checked.
import { createServer } from "node:http";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("node:dns/promises", async (orig) => ({
  ...(await orig<typeof import("node:dns/promises")>()),
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));
vi.mock("node:dns", async (orig) => {
  const real = await orig<typeof import("node:dns")>();
  const lookup = (_host: string, _opts: unknown, cb: (e: null, a: Array<{ address: string; family: number }>) => void) => cb(null, [{ address: "127.0.0.1", family: 4 }]);
  return { ...real, default: { ...real, lookup }, lookup };
});

const { DEFAULT_HTTP, FetchFailure, HttpClient } = await import("../src/collector/http.ts");

let close: (() => void) | undefined;
afterEach(() => close?.());

test("a name that rebinds to a private address between check and connect is refused", async () => {
  let hits = 0;
  const server = createServer((_q, res) => void (hits++, res.end("internal")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  close = () => server.close();
  const port = (server.address() as { port: number }).port;
  const client = new HttpClient({ ...DEFAULT_HTTP, retries: 0 });
  const failure = await client.get(`http://rebind.example:${port}/`, {}).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(FetchFailure);
  expect(failure).toMatchObject({ kind: "blocked_url" });
  expect(hits).toBe(0);
});
