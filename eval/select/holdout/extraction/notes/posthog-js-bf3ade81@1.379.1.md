## 1.379.1

### Patch Changes

- [#3570](https://github.com/PostHog/posthog-js/pull/3570) [`4a27ced`](https://github.com/PostHog/posthog-js/commit/4a27ced9567cf6aa6d5044fe3a0378f730661cfe) Thanks [@gruessi](https://github.com/gruessi)! - fix(record): release iframe documents and observers on iframe removal — same-origin iframes mounted and unmounted while session recording is active no longer leak their `Document`, every node serialized into the mirror, or one `MutationObserver` per mount. Closes eight retainer chains: load-listener disposers, named pagehide handlers, the `recordCrossOriginIframes` cleanup gate (now applied to same-origin too), captured `Document` / `Window` sets that survive `iframe.src` swap-to-`about:blank` before removal, and the global `mutationBuffers[]` / `handlers[]` arrays which previously accumulated forever. Validated end-to-end: a host page that mounts/unmounts 5 blob-URL iframes every 2s for 110s went from +118 MB / +390 leaked `HTMLDocument`s to ~0 MB / 0.
  (2026-06-03)

- [#3717](https://github.com/PostHog/posthog-js/pull/3717) [`1688b38`](https://github.com/PostHog/posthog-js/commit/1688b380a27a57d6439d0bca936019a3fd6d63e2) Thanks [@turnipdabeets](https://github.com/turnipdabeets)! - Move the OpenTelemetry logs dependencies to `devDependencies`. They are only used to build the CDN-served `logs` extension chunk, which inlines them, so consumers no longer install the transitive `protobufjs` (whose `eval("require")` tripped `unsafe-eval` Content Security Policies).

    If you imported `@opentelemetry/*` directly while relying on it being hoisted from `posthog-js`, add it to your own dependencies. (2026-06-03)

- Updated dependencies []:
    - @posthog/types@1.379.1
    - @posthog/core@1.30.4