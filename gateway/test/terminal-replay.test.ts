import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";

function replay(reduced = false) {
  const elements = new Map<string, any>();
  const element = () => ({ hidden: true, textContent: "", attributes: new Set(), handlers: {} as Record<string, () => void>,
    addEventListener(event: string, fn: () => void) { this.handlers[event] = fn; },
    setAttribute(name: string) { this.attributes.add(name); }, removeAttribute(name: string) { this.attributes.delete(name); } });
  for (const name of [".term-controls", ".term-progress", ".term-result", "[data-demo-toggle]", "[data-demo-finish]", "[data-demo-status]", "[data-demo-stage]", "[data-demo-detail]"]) elements.set(name, element());
  elements.get(".term-result").hidden = false;
  const classes = new Set();
  const demo = { querySelector: (name: string) => elements.get(name), classList: { add: (n: string) => classes.add(n), remove: (n: string) => classes.delete(n) } };
  const events: Record<string, () => void> = {};
  const document = { hidden: false, querySelectorAll: () => [], getElementById: (id: string) => id === "terminal-demo" ? demo : null, addEventListener: (name: string, fn: () => void) => { events[name] = fn; } };
  let observe: (entries: { isIntersecting: boolean }[]) => void = () => {};
  class Observer { constructor(fn: typeof observe) { observe = fn; } observe() {} }
  const frames = new Map<number, (now: number) => void>();
  let id = 0;
  const motion = { matches: reduced, addEventListener() {} };
  const source = readFileSync(new URL("../site/site.js", import.meta.url), "utf8").replace(/^import .*;$/m, "");
  runInNewContext(source, { document, window: { IntersectionObserver: Observer }, IntersectionObserver: Observer, matchMedia: () => motion,
    requestAnimationFrame: (fn: (now: number) => void) => { frames.set(++id, fn); return id; }, cancelAnimationFrame: (n: number) => frames.delete(n) });
  return { elements, classes, frames, document, events, visible: (v: boolean) => observe([{ isIntersecting: v }]),
    tick(now: number) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(now)); } };
}

test("plays once on visibility, then keeps results readable until replay is requested", () => {
  const r = replay();
  expect(r.frames.size).toBe(0);
  r.visible(true); r.tick(0); r.tick(1600);
  expect(r.elements.get("[data-demo-stage]").textContent).toContain("step 2/5");
  r.tick(7600);
  expect(r.classes.has("term-running")).toBe(false);
  expect(r.elements.get(".term-result").attributes.has("aria-hidden")).toBe(false);
  expect(r.frames.size).toBe(0);
  r.visible(false); r.visible(true);
  expect(r.frames.size).toBe(0);
  r.elements.get("[data-demo-toggle]").handlers.click();
  expect(r.classes.has("term-running")).toBe(true);
});

test("pause and hidden tabs exclude elapsed time; show results ends the animation", () => {
  const r = replay(); r.visible(true); r.tick(0); r.tick(1000);
  r.elements.get("[data-demo-toggle]").handlers.click(); r.tick(10000);
  expect(r.frames.size).toBe(0);
  r.elements.get("[data-demo-toggle]").handlers.click(); r.tick(11000);
  expect(r.elements.get("[data-demo-stage]").textContent).toContain("step 1/5");
  r.document.hidden = true; r.events.visibilitychange!(); r.tick(20000);
  r.document.hidden = false; r.events.visibilitychange!(); r.tick(30000);
  expect(r.elements.get("[data-demo-stage]").textContent).toContain("step 1/5");
  r.elements.get("[data-demo-finish]").handlers.click();
  expect(r.frames.size).toBe(0);
  expect(r.elements.get(".term-progress").hidden).toBe(true);
});

test("reduced motion keeps the server-rendered final output and starts no animation", () => {
  const r = replay(true); r.visible(true);
  expect(r.frames.size).toBe(0);
  expect(r.classes.has("term-running")).toBe(false);
  expect(r.elements.get(".term-controls").hidden).toBe(true);
});
