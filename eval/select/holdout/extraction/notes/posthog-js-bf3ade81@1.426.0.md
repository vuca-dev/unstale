## 1.426.0

### Minor Changes

- [#4740](https://github.com/PostHog/posthog-js/pull/4740) [`6325953`](https://github.com/PostHog/posthog-js/commit/6325953c32555407ad043cd41d8976cf90839bd5) Thanks [@mayteio](https://github.com/mayteio)! - Capture Meta's `$fbc` person property when a new `fbclid` is observed.
  (2026-09-03)

### Patch Changes

- [#4760](https://github.com/PostHog/posthog-js/pull/4760) [`41ed3af`](https://github.com/PostHog/posthog-js/commit/41ed3af41c1a98776d1686caf4e58875f95b0847) Thanks [@marandaneto](https://github.com/marandaneto)! - Require a distinct ID when calling `identify` and correct its API documentation to match the existing runtime validation.
  (2026-09-03)

- [#4713](https://github.com/PostHog/posthog-js/pull/4713) [`7a027ad`](https://github.com/PostHog/posthog-js/commit/7a027ad1a5d3539f2381293b8ca886d1fff509b8) Thanks [@posthog](https://github.com/apps/posthog)! - Gate `$groupidentify` on person processing. Under `identified_only`, a `group()` call promotes the user to identified so the event is kept instead of dropped. Under `never`, the local group association is retained for subsequent events and feature flags, but `$groupidentify` is not sent because the server always drops it.
  (2026-09-03)
- Updated dependencies [[`41ed3af`](https://github.com/PostHog/posthog-js/commit/41ed3af41c1a98776d1686caf4e58875f95b0847), [`dbbb58e`](https://github.com/PostHog/posthog-js/commit/dbbb58e286db3762673f71995a8aeea89aa44123)]:
  - @posthog/types@1.408.1
  - @posthog/core@1.50.3