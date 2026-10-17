## 1.337.0

### Minor Changes

- [#2996](https://github.com/PostHog/posthog-js/pull/2996) [`7768010`](https://github.com/PostHog/posthog-js/commit/77680105f1e8baf5ed1934d423494793d11ff01a) Thanks [@matheus-vb](https://github.com/matheus-vb)! - Filter out flags marked as failed before merging with cached values, preventing transient backend errors from overwriting previously evaluated flag states
  (2026-02-03)

- [#3000](https://github.com/PostHog/posthog-js/pull/3000) [`4a1af3b`](https://github.com/PostHog/posthog-js/commit/4a1af3bcdc659127fbdab43dbfe887096bfd9c8d) Thanks [@veryayskiy](https://github.com/veryayskiy)! - Render markdown in support product
  (2026-02-03)

### Patch Changes

- [#3001](https://github.com/PostHog/posthog-js/pull/3001) [`9bd4dbc`](https://github.com/PostHog/posthog-js/commit/9bd4dbc89017b009cdbdc6ac21456b1f2bc590f4) Thanks [@adboio](https://github.com/adboio)! - do not intercept element clicks if a product tour fails to show
  (2026-02-03)
- Updated dependencies [[`7768010`](https://github.com/PostHog/posthog-js/commit/77680105f1e8baf5ed1934d423494793d11ff01a)]:
    - @posthog/core@1.18.0
    - @posthog/types@1.337.0