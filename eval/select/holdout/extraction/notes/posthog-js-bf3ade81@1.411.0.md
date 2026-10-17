## 1.411.0

### Minor Changes

- [#4266](https://github.com/PostHog/posthog-js/pull/4266) [`43d1850`](https://github.com/PostHog/posthog-js/commit/43d18506565b491c4a1013f9237aa732ae3d6f4e) Thanks [@posthog](https://github.com/apps/posthog)! - feat: add opt-in `capture_performance.__preview_web_vitals_soft_navs` to fix inflated web vitals on single-page apps

    Client-side route changes in SPAs previously left web vitals (LCP especially) accumulating against the original hard-navigation timestamp, inflating the top tail of Core Web Vitals. Setting `capture_performance: { __preview_web_vitals_soft_navs: true }` now scopes metrics to the browser's Soft Navigation entries so each route change starts a fresh measurement window. It's a preview option because it relies on Chrome's experimental Soft Navigation Detection API and loads pinned stable web-vitals 6.x callbacks; when disabled (the default), the existing web-vitals 5.x behavior remains unchanged. (2026-08-04)

### Patch Changes

- [#4287](https://github.com/PostHog/posthog-js/pull/4287) [`d3c4538`](https://github.com/PostHog/posthog-js/commit/d3c4538b7c22aa468aa0ab9e0edb63d2966618e7) Thanks [@posthog](https://github.com/apps/posthog)! - Keep `$referring_domain` and canonical `utm_*`/campaign parameters on minimal `$feature_flag_called` events. Previously the minimal allowlist stripped every campaign parameter, so a flag-called event landing first in a session could set the session's UTM attribution and channel type to NULL in web analytics.
  (2026-08-04)
- Updated dependencies [[`d3c4538`](https://github.com/PostHog/posthog-js/commit/d3c4538b7c22aa468aa0ab9e0edb63d2966618e7), [`43d1850`](https://github.com/PostHog/posthog-js/commit/43d18506565b491c4a1013f9237aa732ae3d6f4e)]:
    - @posthog/core@1.46.7
    - @posthog/types@1.401.0