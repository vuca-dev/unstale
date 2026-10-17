## 1.429.0

### Minor Changes

- [#4707](https://github.com/PostHog/posthog-js/pull/4707) [`b441eb2`](https://github.com/PostHog/posthog-js/commit/b441eb20dad495c414efd9bfe89b7b2e31d21b9d) Thanks [@posthog](https://github.com/apps/posthog)! - Segment integration: allow `segment` to accept an integration config with `filterProperties`, so customers can filter PostHog-generated enrichment properties before Segment sends an event to its destinations. Returning `null` or throwing leaves the original Segment event unenriched.
  (2026-09-09)

### Patch Changes

- [#4876](https://github.com/PostHog/posthog-js/pull/4876) [`0c2a15f`](https://github.com/PostHog/posthog-js/commit/0c2a15f85ed04f91bc5337346752b9b2ed9703b3) Thanks [@dustinbyrne](https://github.com/dustinbyrne)! - Fix dead-click detection for text selection and editable caret gestures when mouse release is delayed, while continuing to report inert text clicks.
  (2026-09-09)

- [#4733](https://github.com/PostHog/posthog-js/pull/4733) [`24fa541`](https://github.com/PostHog/posthog-js/commit/24fa541d9e9c2313a2e38383a83076e1473c9fe6) Thanks [@dustinbyrne](https://github.com/dustinbyrne)! - fix(web): avoid reporting clicks that select or unselect text as dead clicks
  (2026-09-09)

- [#4882](https://github.com/PostHog/posthog-js/pull/4882) [`4bd37b7`](https://github.com/PostHog/posthog-js/commit/4bd37b77f265898f288f88d11374d99c3149e630) Thanks [@lucasheriques](https://github.com/lucasheriques)! - Fix TypeScript compatibility between public replay events and the replay player.
  (2026-09-09)

- [#4833](https://github.com/PostHog/posthog-js/pull/4833) [`f1395b6`](https://github.com/PostHog/posthog-js/commit/f1395b6ce91af909ae0fdf095886f251f569a891) Thanks [@posthog](https://github.com/apps/posthog)! - Keep surveys hidden while capture is disabled and preserve answers if capture stops before submission.
  (2026-09-09)
- Updated dependencies [[`0c2a15f`](https://github.com/PostHog/posthog-js/commit/0c2a15f85ed04f91bc5337346752b9b2ed9703b3), [`24fa541`](https://github.com/PostHog/posthog-js/commit/24fa541d9e9c2313a2e38383a83076e1473c9fe6), [`b441eb2`](https://github.com/PostHog/posthog-js/commit/b441eb20dad495c414efd9bfe89b7b2e31d21b9d)]:
  - @posthog/types@1.410.0