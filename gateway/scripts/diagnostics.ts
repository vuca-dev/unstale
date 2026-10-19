// Read-only diagnostics for the production gateway, run by .github/workflows/gateway-diagnostics.yml (no local
// Cloudflare credentials needed). Prints nothing secret: tokens come from the environment and only counters, status
// codes, log lines and exception messages are printed; a requested package's name (`?purl=`) is redacted.
//
//   node gateway/scripts/diagnostics.ts analytics [--hours 48]   Durable Object rows read/written, requests, storage
//                                                                 per hour, and the Worker's invocations by status
//   node gateway/scripts/diagnostics.ts tail <file.jsonl>        a summary of `wrangler tail --format json` output
//
// analytics needs CLOUDFLARE_API_TOKEN (Account Analytics: Read) and CLOUDFLARE_ACCOUNT_ID. The datasets' fields are
// read from the GraphQL schema first, so a field Cloudflare adds or drops does not break the query.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const API = "https://api.cloudflare.com/client/v4";
const SCRIPT = "unstale";

const { positionals, values } = parseArgs({ allowPositionals: true, options: { hours: { type: "string", default: "48" } } });

interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}
interface Field {
  name: string;
  type: TypeRef;
  args?: { name: string; type: TypeRef }[];
}

const named = (t: TypeRef): TypeRef => (t.ofType ? named(t.ofType) : t);

async function graphql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: unknown; errors?: { message: string }[] | null };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return body.data;
}

const typeCache = new Map<string, Field[]>();
async function fieldsOf(name: string, input = false): Promise<Field[]> {
  if (typeCache.has(name)) return typeCache.get(name)!;
  const ref = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";
  const data = await graphql(`query($n: String!) { __type(name: $n) { fields { name type { ${ref} } args { name type { ${ref} } } } inputFields { name type { ${ref} } } } }`, { n: name });
  const fields: Field[] = (input ? data.__type?.inputFields : data.__type?.fields) ?? [];
  typeCache.set(name, fields);
  return fields;
}

/** The type `viewer.accounts` returns (its fields are the datasets), found from the query root. */
let accountTypeName: string | undefined;
async function accountType(): Promise<string> {
  if (accountTypeName) return accountTypeName;
  const root = (await graphql("{ __schema { queryType { name } } }")).__schema.queryType.name as string;
  const viewer = (await fieldsOf(root)).find((f) => f.name === "viewer");
  const accounts = (await fieldsOf(named(viewer!.type).name!)).find((f) => f.name === "accounts");
  return (accountTypeName = named(accounts!.type).name!);
}

const scalars = async (typeName: string): Promise<string[]> =>
  (await fieldsOf(typeName)).filter((f) => ["SCALAR", "ENUM"].includes(named(f.type).kind)).map((f) => f.name);

/** One dataset over [since, until), grouped by hour (or the finest time dimension it has) and the given keys. */
async function dataset(name: string, since: Date, until: Date, filter: Record<string, unknown>, keys: string[]): Promise<{ rows: any[]; fields: string[] } | string> {
  const account = await fieldsOf(await accountType());
  const field = account.find((f) => f.name === name);
  if (!field) return `not in the schema`;
  const group = named(field.type).name!;
  const parts = await fieldsOf(group);
  const dims = parts.find((f) => f.name === "dimensions");
  const dimNames = dims ? await scalars(named(dims.type).name!) : [];
  const time = ["datetimeHour", "datetime", "date"].find((d) => dimNames.includes(d));
  const filterType = named(field.args!.find((a) => a.name === "filter")!.type).name!;
  const filterFields = (await fieldsOf(filterType, true)).map((f) => f.name);
  const range = ["datetimeHour", "datetime", "date"].find((d) => filterFields.includes(`${d}_geq`))!;
  const fmt = (d: Date) => (range === "date" ? d.toISOString().slice(0, 10) : d.toISOString().replace(/\.\d+Z$/, "Z"));
  const where: Record<string, unknown> = { [`${range}_geq`]: fmt(since), [`${range}_lt`]: fmt(until), ...filter };
  for (const k of Object.keys(filter)) if (!filterFields.includes(k)) delete where[k];
  const sel: string[] = [];
  const shown: string[] = [];
  const dimSel = [time, ...keys.filter((k) => dimNames.includes(k))].filter(Boolean) as string[];
  if (dimSel.length) sel.push(`dimensions { ${dimSel.join(" ")} }`);
  for (const agg of ["sum", "max", "avg"]) {
    const f = parts.find((p) => p.name === agg);
    if (!f) continue;
    const names = await scalars(named(f.type).name!);
    if (names.length) {
      sel.push(`${agg} { ${names.join(" ")} }`);
      shown.push(...names.map((n) => `${agg}.${n}`));
    }
  }
  if (parts.some((p) => p.name === "count")) {
    sel.push("count");
    shown.push("count");
  }
  const order = time ? `, orderBy: [${time}_ASC]` : "";
  const q = `query($a: String!, $f: ${filterType}!) { viewer { accounts(filter: { accountTag: $a }) { ${name}(limit: 10000, filter: $f${order}) { ${sel.join(" ")} } } } }`;
  try {
    const data = await graphql(q, { a: process.env.CLOUDFLARE_ACCOUNT_ID, f: where });
    return { rows: data.viewer.accounts[0]?.[name] ?? [], fields: shown };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Prints the non-zero columns of a dataset's rows, one line per group. */
function print(title: string, result: { rows: any[]; fields: string[] } | string, keyOf: (row: any) => string): void {
  console.log(`\n== ${title}`);
  if (typeof result === "string") return void console.log(`  unavailable: ${result}`);
  if (!result.rows.length) return void console.log("  no rows in the range");
  const value = (row: any, f: string) => (f === "count" ? row.count : row[f.split(".")[0]!]?.[f.split(".")[1]!]);
  const cols = result.fields.filter((f) => result.rows.some((r) => Number(value(r, f)) !== 0 && value(r, f) != null));
  console.log(`  ${"group".padEnd(34)} ${cols.join("  ")}`);
  const totals = cols.map(() => 0);
  for (const row of result.rows) {
    const vals = cols.map((f, i) => {
      const v = value(row, f);
      if (f.startsWith("sum.") || f === "count") totals[i]! += Number(v) || 0;
      return String(v ?? "");
    });
    console.log(`  ${keyOf(row).padEnd(34)} ${vals.map((v, i) => v.padStart(cols[i]!.length)).join("  ")}`);
  }
  console.log(`  ${"total (sums)".padEnd(34)} ${totals.map((t, i) => (cols[i]!.startsWith("sum.") || cols[i] === "count" ? String(t) : "").padStart(cols[i]!.length)).join("  ")}`);
}

async function rest(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } });
  const body = (await res.json()) as { result?: unknown; errors?: { message: string }[] };
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(body.errors ?? []).map((e) => e.message).join("; ")}`);
  return body.result;
}

async function analytics(): Promise<void> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account || !process.env.CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
  const hours = Math.max(1, Math.min(24 * 7, Number(values.hours) || 48));
  const until = new Date(Math.ceil(Date.now() / 3600_000) * 3600_000);
  const since = new Date(until.getTime() - hours * 3600_000);
  console.log(`range: ${since.toISOString()} .. ${until.toISOString()} (${hours} h, UTC)`);

  // The Worker's Durable Object namespaces, so only this gateway's rows are shown.
  let namespaces: string[] = [];
  try {
    const all = (await rest(`/accounts/${account}/workers/durable_objects/namespaces?per_page=100`)) as { id: string; name?: string; script?: string; class?: string }[];
    const mine = all.filter((n) => n.script === SCRIPT);
    namespaces = mine.map((n) => n.id);
    console.log(`namespaces of ${SCRIPT}: ${mine.map((n) => `${n.class ?? n.name} ${n.id}`).join(", ") || "none found"}`);
  } catch (error) {
    console.log(`namespaces not listed (${error instanceof Error ? error.message : error}); showing every namespace`);
  }
  const ns = namespaces.length === 1 ? { namespaceId: namespaces[0] } : {};

  // Queried a day at a time: some datasets allow at most a day's range per query.
  const days: [Date, Date][] = [];
  for (let t = since.getTime(); t < until.getTime(); t += 86_400_000) days.push([new Date(t), new Date(Math.min(until.getTime(), t + 86_400_000))]);
  const merged = async (name: string, filter: Record<string, unknown>, keys: string[]) => {
    const out: { rows: any[]; fields: string[] } = { rows: [], fields: [] };
    for (const [a, b] of days) {
      const r = await dataset(name, a, b, filter, keys);
      if (typeof r === "string") return r;
      out.rows.push(...r.rows);
      out.fields = r.fields;
    }
    return out;
  };
  const when = (row: any) => String(row.dimensions?.datetimeHour ?? row.dimensions?.datetime ?? row.dimensions?.date ?? "").replace(":00:00Z", "Z");
  const tag = (row: any, k: string) => (row.dimensions?.[k] !== undefined && namespaces.length !== 1 ? ` ${String(row.dimensions[k]).slice(0, 8)}` : "");

  print("Durable Object periodic (rows read/written, storage units, CPU) per hour", await merged("durableObjectsPeriodicGroups", ns, ["namespaceId"]), (r) => when(r) + tag(r, "namespaceId"));
  print("Durable Object invocations (requests, errors) per hour and status", await merged("durableObjectsInvocationsAdaptiveGroups", ns, ["namespaceId", "status"]), (r) => `${when(r)} ${r.dimensions?.status ?? ""}${tag(r, "namespaceId")}`);
  print("Durable Object SQL storage per hour", await merged("durableObjectsSqlStorageGroups", ns, ["namespaceId"]), (r) => when(r) + tag(r, "namespaceId"));
  print("Durable Object storage per hour", await merged("durableObjectsStorageGroups", {}, []), when);
  print(`Worker ${SCRIPT} invocations per hour and status`, await merged("workersInvocationsAdaptive", { scriptName: SCRIPT }, ["status"]), (r) => `${when(r)} ${r.dimensions?.status ?? ""}`);
}

/** wrangler tail's JSON events, without headers, client details or anything else a request carried. */
function tail(file: string): void {
  const text = (() => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  })();
  const events: any[] = [];
  // One JSON object per event, possibly pretty-printed over several lines.
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" && depth++ === 0) start = i;
    else if (c === "}" && --depth === 0 && start >= 0) {
      try {
        events.push(JSON.parse(text.slice(start, i + 1)));
      } catch {
        // a partial event at the end of the capture
      }
    }
  }
  console.log(`${events.length} events captured`);
  const outcomes = new Map<string, number>();
  for (const e of events) {
    outcomes.set(String(e.outcome), (outcomes.get(String(e.outcome)) ?? 0) + 1);
    const req = e.event?.request;
    let path = "";
    if (req?.url) {
      const u = new URL(req.url);
      // The package a client asked about is never printed (the workflow's logs are public): only that it asked.
      path = `${req.method} ${u.host}${u.pathname}${u.searchParams.has("purl") ? "?purl=(redacted)" : ""}`;
    } else if (e.event?.rpcMethod) path = `rpc ${e.event.rpcMethod}`;
    else if (e.event) path = Object.keys(e.event).join(",");
    const status = e.event?.response?.status ?? "";
    const at = e.eventTimestamp ? new Date(e.eventTimestamp).toISOString().slice(11, 19) : "";
    console.log(`\n${at} ${e.scriptName ?? ""}${e.entrypoint ? `:${e.entrypoint}` : ""} ${e.outcome} ${status} ${path}`);
    for (const x of e.exceptions ?? []) console.log(`  exception ${x.name}: ${String(x.message).slice(0, 500)}`);
    for (const l of e.logs ?? []) console.log(`  ${l.level}: ${(Array.isArray(l.message) ? l.message.map(String).join(" ") : String(l.message)).slice(0, 500)}`);
  }
  console.log(`\noutcomes: ${[...outcomes].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
}

const [command, arg] = positionals;
if (command === "analytics") await analytics();
else if (command === "tail" && arg) tail(arg);
else {
  console.error("usage: diagnostics.ts analytics [--hours 48] | tail <file.jsonl>");
  process.exit(2);
}
