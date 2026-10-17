## v3.0.0 (2026-09-28)

- v3.0.0 (#2692) (2bb43428b79ac06f94bb8ea8aeacd6102fe31f56) @kettanaito @Andarist

### ⚠️ BREAKING CHANGES

- **MSW is now ESM-only** (#2765).
- Deprecate support for Node.js v18 and v20 (#2729). The minimal supported Node.js version is v22.
- `msw/native` is removed in favor of [`@msw/react-native`](https://github.com/mswjs/react-native).
- Require TypeScript 5.9 as the minimal version.
- Deprecate support for TypeScript 5.1 and 5.2 (#2730)
- `worker.stop()` returns a Promise (#2724). Awaiting it is relevant only for in-flight critical scenarios.
- `graphql` is now exported as `msw/graphql` (#2691). GraphQL is now handled as a proper optional peer dependency.
- Removes the `handleRequest()` utility. Please use the `defineNetwork()` API instead.
- `GraphQLLinkHandlers` type has been renamed to `GraphQLLink`.
- The `file://` requests now throw in Node.js as they normally do (not supported by `fetch`).
- The `Content-Length` request header is now removed by `bypass()`.
- HTTP-to-WebSocket upgrade requests performed via `fetch()` now throw in Node.js as they normally do (not supported by `fetch`).
- Cookies are no longer managed in Node.js for better compatibility. Instead, whatever is the default behavior of your environment that's the cookie behavior you get. This has no effect on the browser.
- WebSocket `connection` life cycle event has been renamed to `websocket:connection` (#2783).
- `onUnhandledRequest` option has been renamed to `onUnhandledFrame`.
- The library no longer patches `setTimeout` to circumvent fake timers in test runners. You should advance the fake timers normally for delayed mocked responses to resolve.
- The library no longer returns a mocked cookie string on `request.headers.get('cookie')` in the handlers. It returns `null` in all environments. Please use the `cookies` resolver argument to have cookie-based logic.

### Features

- Supports Node.js v24 and v26.
- Supports TypeScript v6.0 and v7.0.
- You can import individual utilities, like `delay` or `passthrough`, from the new `msw/utils` entrypoint for smaller footprint on your bundle.
- Support GraphQL v17.0.
- Support intercepting page navigations and form submissions (#2721).
- Support GraphQL subscriptions (#285, #2763).
- Migrate from `path-to-regexp` to `@msw/url` (#2678).
- Remove the following dependencies:
  - `graphql`
  - `path-to-regexp`
  - `picocolors`
  - `statuses`
  - `strict-event-emitter`
- Adds a Vite plugin for MSW (#2781).
- Adds a `websocket:error` life cycle event to listen to WebSocket connection errors (#2784).
- Support modifying the intercepted request headers in passthrough scenarios (#2786).
- Support a new WebSocket Extension API that allows for better custom experiences (#2791).

### Bug fixes

- Fix an issue where preventing a page closure via the `beforeunload` listener would unregister the MSW worker (#1105).
- Fix an issue that caused intermittent test failures in Vitest Browser Mode and Firefox if using `maxWorkers: 1` (#2726). 
- Fix an issue where in-flight requests were incorrectly passthrough when performed before calling `worker.stop()` (#2724, #2597).
- Fix an issue where persisting cookies in `localStorage` would cause a maximum quota exceeded errors.
- Fix various issues related to the network interception in Node.js.