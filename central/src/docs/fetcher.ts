// The resolver's HTTP through the polite client: URL safety, per-host limits, robots.txt for crawled sites (registry
// and GitHub APIs are exempt), and a per-run memo, since the resolver reads some responses twice.
import { execFileSync } from "node:child_process";
import { decode } from "../collector/decode.ts";
import { DEFAULT_HEADERS, FetchFailure, type HttpClient } from "../collector/http.ts";
import type { Fetcher, Res } from "./resolve.ts";
import type { RobotsCache } from "./robots.ts";

const API_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com", "registry.npmjs.org", "pypi.org", "crates.io"]);

export function githubToken(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function httpFetcher(http: HttpClient, robots: RobotsCache, token = githubToken()): Fetcher {
  const memo = new Map<string, Promise<Res>>();
  let requests = 0;
  const once = async (url: string, accept: string, gh: boolean): Promise<Res> => {
    const u = new URL(url);
    if (!API_HOSTS.has(u.hostname) && u.pathname !== "/robots.txt" && !(await robots.allowed(url))) return { status: 0, url, text: "robots.txt disallows" };
    requests++;
    const headers: Record<string, string> = { ...DEFAULT_HEADERS, accept };
    // The token goes only to the API path as written: a `.` or `..` segment (which URL parsing resolves away) means a
    // slug from crawled text was steering the request to another endpoint.
    const dotted = /\/(?:\.|%2e){1,2}(?:[/?#]|$)/i.test(url.split("api.github.com")[1] ?? "");
    if (gh && token && u.hostname === "api.github.com" && !dotted) headers.authorization = `Bearer ${token}`;
    try {
      const res = await http.get(url, headers);
      return { status: res.status, url: res.finalUrl, text: decode(res.body, res.headers.get("content-type")) };
    } catch (e) {
      if (!(e instanceof FetchFailure)) throw e;
      return { status: e.httpStatus ?? 0, url, text: "" };
    }
  };
  return {
    get requests() {
      return requests;
    },
    get(url: string, accept = "text/html,*/*;q=0.8", gh = false) {
      const clean = url.replace(/#retry$/, "");
      const key = `${accept} ${clean}`;
      let r = memo.get(key);
      if (!r || url.endsWith("#retry")) memo.set(key, (r = once(clean, accept, gh)));
      return r;
    },
  };
}
