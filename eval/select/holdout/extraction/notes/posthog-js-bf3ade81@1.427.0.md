## 1.427.0

### Minor Changes

- [#4774](https://github.com/PostHog/posthog-js/pull/4774) [`426e1fd`](https://github.com/PostHog/posthog-js/commit/426e1fd6c001c030e5753d0d25a0bdb9adc99448) Thanks [@Fhatu12](https://github.com/Fhatu12)! - Add `reuseAnonymousId` support to browser identify calls.
  (2026-09-04)

### Patch Changes

- [#4782](https://github.com/PostHog/posthog-js/pull/4782) [`b64b113`](https://github.com/PostHog/posthog-js/commit/b64b1135ce377360075cfdbaf8e0a74b46330116) Thanks [@posthog](https://github.com/apps/posthog)! - Stop counting stack frames that have no filename (in-app browser bridge scripts and other code the runtime reports without a script URL) as in-app code.
  (2026-09-04)

- [#4758](https://github.com/PostHog/posthog-js/pull/4758) [`dd74222`](https://github.com/PostHog/posthog-js/commit/dd742227d86a764d0017374ecc3709b6468dea17) Thanks [@marandaneto](https://github.com/marandaneto)! - Keep relaying session recording events when a cross-origin iframe redirects through the parent page's origin.
  (2026-09-04)
- Updated dependencies [[`b64b113`](https://github.com/PostHog/posthog-js/commit/b64b1135ce377360075cfdbaf8e0a74b46330116), [`426e1fd`](https://github.com/PostHog/posthog-js/commit/426e1fd6c001c030e5753d0d25a0bdb9adc99448)]:
  - @posthog/core@1.50.5
  - @posthog/types@1.409.0