## 1.407.0

### Minor Changes

- [#4222](https://github.com/PostHog/posthog-js/pull/4222) [`0f2407b`](https://github.com/PostHog/posthog-js/commit/0f2407bbd98cab7d38a23f0466bbdccf3e0bdbf3) Thanks [@turnipdabeets](https://github.com/turnipdabeets)! - feat: add a default-value option to `isFeatureEnabled`

    `isFeatureEnabled(key, { defaultValue: false })` now returns the given default when the flag has no value — flags not loaded yet, or no flag with that key — and the return type narrows to `boolean`. The option name is the same in posthog-js, posthog-js-lite, and posthog-react-native. Without `defaultValue`, behavior is unchanged: `boolean | undefined`. (2026-07-22)

### Patch Changes

- [#4203](https://github.com/PostHog/posthog-js/pull/4203) [`90e7483`](https://github.com/PostHog/posthog-js/commit/90e7483435757b6e650210e7d9d2f2ed2acb92e7) Thanks [@posthog](https://github.com/apps/posthog)! - fix(conversations): let users start a new conversation while a ticket is still open

    The support widget now surfaces the ticket list navigation (and its "New conversation"
    button) whenever the user has any ticket, instead of only when they have multiple tickets
    or a single resolved one. Previously a user sitting on one open, unresolved ticket was
    locked into that conversation with no way to raise a second issue. (2026-07-22)

- [#4221](https://github.com/PostHog/posthog-js/pull/4221) [`da6e082`](https://github.com/PostHog/posthog-js/commit/da6e082daeb6f03d3982a101d74ac4efae990f8a) Thanks [@posthog](https://github.com/apps/posthog)! - fix(exception-autocapture): don't throw when the page's onerror handler is non-callable

    The wrapped `window.onerror`, `window.onunhandledrejection`, and `console.error` handlers
    chained to the page's original handler using optional chaining, which only guards against
    `null`/`undefined`. When a page had one of these set to a truthy non-callable value (e.g.
    via `Object.defineProperty`, or clobbered by another script/extension), our wrapper threw a
    `TypeError` from inside its own handler. We now check the original handler is actually
    callable before invoking it and fall back to `false` otherwise. (2026-07-22)

- [#4209](https://github.com/PostHog/posthog-js/pull/4209) [`569fc62`](https://github.com/PostHog/posthog-js/commit/569fc62f418b3c5b7daed27e8fed38b208e9061c) Thanks [@posthog](https://github.com/apps/posthog)! - Session recording no longer emits an uncaught `TypeError: Illegal invocation` from the input observer's _synchronous_ native-setter call. The previous fix only guarded the deferred hooked setter; the synchronous `original.set.call(this, value)` still ran with a non-native `this` (a proxy, custom element, or cross-realm object) and threw inside the host page's own assignment. The recorder now probes the native getter — which fails the same internal-slot brand check as the setter — before forwarding: a non-native `this` is skipped, so the recorder no longer re-throws from its own frame, while genuine elements (including file inputs that legitimately throw on a programmatic value) keep their native behavior. The input event handler and `getInputType` are similarly guarded against reading native accessors on a non-native `this`.
  (2026-07-22)

- [#4068](https://github.com/PostHog/posthog-js/pull/4068) [`d5e1188`](https://github.com/PostHog/posthog-js/commit/d5e1188c380832bae0980d82ac6a35069908b7df) Thanks [@posthog](https://github.com/apps/posthog)! - Fix event-triggered surveys re-displaying in a fresh session without their trigger firing. A non-repeatable event/action-triggered survey that was shown but never dismissed or answered had its activation persisted indefinitely, so it kept being treated as "triggered" on later page loads. The persisted activation is now scoped to the triggering session: it still survives a reload within that session, but a brand-new session drops it until the trigger fires again. Repeatable surveys are unaffected.
  (2026-07-22)

- [#4205](https://github.com/PostHog/posthog-js/pull/4205) [`de3ad61`](https://github.com/PostHog/posthog-js/commit/de3ad612aebbd9bad6b6f63bbe5bc8c1a3ea076c) Thanks [@posthog](https://github.com/apps/posthog)! - Warn when session recording masking options in `posthog.init` shadow the project-level "Privacy and masking" setting. Client-side masking still intentionally takes precedence, but previously the override was silent — a developer could set masking in the dashboard and see it quietly ignored because their SDK config diverged. The recorder now logs a console warning (in debug mode) naming the diverging fields so the precedence is self-explaining.
  (2026-07-22)
- Updated dependencies [[`0f2407b`](https://github.com/PostHog/posthog-js/commit/0f2407bbd98cab7d38a23f0466bbdccf3e0bdbf3)]:
    - @posthog/core@1.45.0
    - @posthog/types@1.398.0