### Major Changes

- breaking: move remote function types to `$app/server` ([#16740](https://github.com/sveltejs/kit/pull/16740))

- breaking: remove `experimental.handleRenderingErrors` flag ([#16265](https://github.com/sveltejs/kit/pull/16265))

- breaking: make `getRequest` and `setResponse` synchronous ([#16280](https://github.com/sveltejs/kit/pull/16280))

- breaking: TypeScript 6 is now the minimum required version ([#15930](https://github.com/sveltejs/kit/pull/15930))

- breaking: refresh all load functions/queries when clicking a link to the current URL ([#16572](https://github.com/sveltejs/kit/pull/16572))

- breaking: move remote function types to `$app/server` ([#16764](https://github.com/sveltejs/kit/pull/16764))

- breaking: upgrade to `cookie` v2. Cookie names must now contain only ASCII characters ([#13386](https://github.com/sveltejs/kit/pull/13386))

- breaking: require Node 22 or newer ([#12548](https://github.com/sveltejs/kit/pull/12548))

- major: error when a client-requested single-flight mutation isn't respected by the server, allow the server to explicitly ignore refreshes ([#16892](https://github.com/sveltejs/kit/pull/16892))

- breaking: remove the `preloadStrategy` option. `modulepreload` will always be used ([#15256](https://github.com/sveltejs/kit/pull/15256))

- breaking: default the cookie `path` option to `'/'` ([#15398](https://github.com/sveltejs/kit/pull/15398))

- breaking: remove `@sveltejs/kit/node/polyfills` ([#15430](https://github.com/sveltejs/kit/pull/15430))

- breaking: add `config.kit.output.linkHeaderPreload` to preload using the `Link` header ([#15939](https://github.com/sveltejs/kit/pull/15939))

- breaking: require `@sveltejs/vite-plugin-svelte` v7 ([#15371](https://github.com/sveltejs/kit/pull/15371))

- breaking: make `page.url` immutable on a type level ([#16256](https://github.com/sveltejs/kit/pull/16256))

- breaking: remove `base`, `assets`, and `resolveRoute` from `$app/paths` ([#15507](https://github.com/sveltejs/kit/pull/15507))

- breaking: remove `createEntries` from the `Builder` object passed to adapter functions ([#15509](https://github.com/sveltejs/kit/pull/15509))

- breaking: return no content for 204 responses ([#16200](https://github.com/sveltejs/kit/pull/16200))

- breaking: rename `Pathname` type to `Path` and `Asset` to `AssetPath` ([#16430](https://github.com/sveltejs/kit/pull/16430))
  breaking: remove leading `/` from `Path` and `AssetPath`
- breaking: `handle`'s `resolve` is now typed to always return a `Promise` ([#16352](https://github.com/sveltejs/kit/pull/16352))

- breaking: remove `Server` constructor and `SSRManifest` from public types ([#16876](https://github.com/sveltejs/kit/pull/16876))

- breaking: require Svelte config options to be passed through the Vite plugin ([#16007](https://github.com/sveltejs/kit/pull/16007))

- breaking: form action responses now use the HTTP status code returned from `fail` ([#16200](https://github.com/sveltejs/kit/pull/16200))

- breaking: write tsconfig to `node_modules/$app/tsconfig` ([#16458](https://github.com/sveltejs/kit/pull/16458))

- breaking: move `defineParams` and associated types to `@sveltejs/kit/params` ([#16716](https://github.com/sveltejs/kit/pull/16716))

- breaking: remove the deprecated CSRF `checkOrigin` option in favor of `trustedOrigins` ([#15437](https://github.com/sveltejs/kit/pull/15437))

- breaking: the `delta` property now only exists for `popstate` navigation events ([#15522](https://github.com/sveltejs/kit/pull/15522))

- breaking: change `form.error` type from `any` to `App.Error | undefined` ([#16245](https://github.com/sveltejs/kit/pull/16245))

- breaking: remove deprecated `pragma` header in version polling for improved CORS support ([#15428](https://github.com/sveltejs/kit/pull/15428))

- breaking: `goto` now rejects when called with a URL that does not resolve to a route within the app, matching the existing behaviour for external URLs ([#16164](https://github.com/sveltejs/kit/pull/16164))

- breaking: run all errors through the `handleError` hook ([#16664](https://github.com/sveltejs/kit/pull/16664))

- breaking: require Svelte 5.56.4 or newer ([#15371](https://github.com/sveltejs/kit/pull/15371))

- breaking: error on `event.url`, `event.params` and `event.route` access inside queries ([#16452](https://github.com/sveltejs/kit/pull/16452))

- breaking: enhanced cross-page form actions now navigate to the action page on success and failure, matching native form behavior ([#16684](https://github.com/sveltejs/kit/pull/16684))

- breaking: delete `$service-worker` module ([#16450](https://github.com/sveltejs/kit/pull/16450))

- breaking: move `defineEnvVars` to `@sveltejs/kit/env` ([#16375](https://github.com/sveltejs/kit/pull/16375))

- breaking: nested server-only directories ([#15685](https://github.com/sveltejs/kit/pull/15685))

- feat: allow adapters to provide additional Vite plugins ([#16206](https://github.com/sveltejs/kit/pull/16206))

- breaking: replace the `$lib` alias with `#lib` and remove `files.lib` config. ([#16360](https://github.com/sveltejs/kit/pull/16360))

- breaking: remove `#lib` definition from `paths`; requires explicit module extensions as a result ([#16736](https://github.com/sveltejs/kit/pull/16736))

- chore: change `error`, `isHttpError`, `redirect`, and `isRedirect` to refer to public type instead of internal class ([#13036](https://github.com/sveltejs/kit/pull/13036))

- breaking: move hooks-related types to `@sveltejs/kit/hooks` ([#16737](https://github.com/sveltejs/kit/pull/16737))

- breaking: add 'error' result type to `preloadData` ([#12579](https://github.com/sveltejs/kit/pull/12579))

- breaking: detect new deployments on data, remote, and form action responses, tab focus, and visibility change, and default `version.pollInterval` to 1 hour ([#16496](https://github.com/sveltejs/kit/pull/16496))

- breaking: disallow cross-origin form submissions without a `Content-Type` header ([#16347](https://github.com/sveltejs/kit/pull/16347))

- breaking: Server-only directories (`/server/` in the path) are now treated as server-only everywhere inside the project (except `src/routes` and the assets directory) ([#16360](https://github.com/sveltejs/kit/pull/16360))

- breaking: `config` exported from a universal route file takes precedence over a server one ([#16400](https://github.com/sveltejs/kit/pull/16400))

- breaking: require Vite 8. Provides new functionality even for existing Vite 8 users such as faster builds with Vite hook filters and more powerful SvelteKit adapters with the Vite environment API ([#15371](https://github.com/sveltejs/kit/pull/15371))

- breaking: remove `data-sveltekit-*` option `'off'` in favour of `false` ([#15907](https://github.com/sveltejs/kit/pull/15907))

- breaking: move tracing out of the experimental namespace and remove the instrumentation flag ([#16260](https://github.com/sveltejs/kit/pull/16260))

- breaking: add `kit.paths.origin` config option, remove `kit.prerender.origin` and the `adapter-node` `ORIGIN` environment variable ([#16161](https://github.com/sveltejs/kit/pull/16161))

- breaking: move `Page`, `ReadonlyURL` and `ReadonlyURLSearchParams` from `@sveltejs/kit` to `$app/state` ([#16694](https://github.com/sveltejs/kit/pull/16694))

- breaking: remove `$app/stores` ([#15499](https://github.com/sveltejs/kit/pull/15499))

- breaking: add `refreshAll` and deprecate `invalidateAll` ([#16289](https://github.com/sveltejs/kit/pull/16289))

- breaking: reject query parameters beginning with `x-sveltekit-` ([#17125](https://github.com/sveltejs/kit/pull/17125))

- breaking: disallow `*.remote.ts/js` files unless `experimental.remoteFunctions` is enabled ([#16247](https://github.com/sveltejs/kit/pull/16247))

- breaking: replace the `noScroll` and `keepFocus` options of `goto` with a single `reset` option, and the `data-sveltekit-noscroll` and `data-sveltekit-keepfocus` attributes with `data-sveltekit-reset` ([#16558](https://github.com/sveltejs/kit/pull/16558))

- breaking: don't abort navigation when calling `invalidate(All)` during navigation ([#16188](https://github.com/sveltejs/kit/pull/16188))

- breaking: consistent special filename patterns ([#16382](https://github.com/sveltejs/kit/pull/16382))

- breaking: allow `handleError` to influence status code ([#16162](https://github.com/sveltejs/kit/pull/16162))

- breaking: delegate CORS handling to Vite for static directory requests during development ([#16357](https://github.com/sveltejs/kit/pull/16357))

- breaking: require `vite@^8.0.12`, the first Vite 8 release bundling stable `rolldown` 1.0.0 ([#16134](https://github.com/sveltejs/kit/pull/16134))

- breaking: only include routes with a `+page` or `+server` in `RouteId` ([#16580](https://github.com/sveltejs/kit/pull/16580))

- breaking: require Node 22.17 ([#16597](https://github.com/sveltejs/kit/pull/16597))

- breaking: deprecate `error(status, {...})` in favour of `error(status, message, {...})` ([#16540](https://github.com/sveltejs/kit/pull/16540))

- breaking: replace the `builder.generateManifest` with `builder.generateServerInstance` and `builder.manifest` ([#16875](https://github.com/sveltejs/kit/pull/16875))

- breaking: forbid external redirects by default ([#16198](https://github.com/sveltejs/kit/pull/16198))

- breaking: separate adapter Vite plugins into `pre` and `post` ([#16711](https://github.com/sveltejs/kit/pull/16711))

- breaking: remove param files in folder in favor of `params.js/ts` file ([#16189](https://github.com/sveltejs/kit/pull/16189))

- breaking: move env-related types to `@sveltejs/kit/env` ([#16739](https://github.com/sveltejs/kit/pull/16739))

- breaking: `preloadCode` now takes a route ID (e.g. `/blog/[slug]`) instead of a pathname. Route IDs are not prefixed with `paths.base` ([#16576](https://github.com/sveltejs/kit/pull/16576))

- breaking: move `BeforeNavigate`, `OnNavigate`, `AfterNavigate`, `Navigation`, `NavigationTarget`, `NavigationType`, `GotoOptions` and the `Navigation*` variant types from `@sveltejs/kit` to `$app/navigation` ([#16694](https://github.com/sveltejs/kit/pull/16694))

- breaking: move `ActionResult` and `SubmitFunction` from `@sveltejs/kit` to `$app/forms` ([#16694](https://github.com/sveltejs/kit/pull/16694))

- breaking: remove `handleValidationError` and pass remote function validation errors to `handleError` with `kind: 'validation'` ([#16672](https://github.com/sveltejs/kit/pull/16672))

- breaking: remove deprecated `.run()` method from live queries ([#16573](https://github.com/sveltejs/kit/pull/16573))

### Minor Changes

- feat: allow hyphens in param and matcher names ([#16284](https://github.com/sveltejs/kit/pull/16284))

- feat: add `$app/manifest` module with `immutable`, `assets`, `prerendered`, and `routes` exports ([#16372](https://github.com/sveltejs/kit/pull/16372))

- feat: ignore files with + prefix if they contain test/spec/stories ([#16715](https://github.com/sveltejs/kit/pull/16715))

- feat: add `ErrorProps` to generated types ([#16272](https://github.com/sveltejs/kit/pull/16272))

- feat: support sourcemaps in production ([#16412](https://github.com/sveltejs/kit/pull/16412))

- feat: return the list of compressed files from `builder.compress` ([#16566](https://github.com/sveltejs/kit/pull/16566))

- feat: better response logging ([#16744](https://github.com/sveltejs/kit/pull/16744))

- feat: warn when tsconfig doesn't exclude service worker ([#16645](https://github.com/sveltejs/kit/pull/16645))

- feat: validate that all remote form fields were created with form.fields.foo.as(...) ([#16331](https://github.com/sveltejs/kit/pull/16331))

- feat: support function validators for environment variables ([#16402](https://github.com/sveltejs/kit/pull/16402))

- feat: use `type: 'module'` for service worker registrations ([#16169](https://github.com/sveltejs/kit/pull/16169))

- feat: allow adapters to receive the Svelte config as a function argument when adding Vite plugins ([#16986](https://github.com/sveltejs/kit/pull/16986))

- feat: add shallow routing to `goto` and deprecate `pushState` and `replaceState` ([#16449](https://github.com/sveltejs/kit/pull/16449))

- feat: abort `request.signal` when the response closes prematurely, via a new `response` option for `getRequest` ([#16793](https://github.com/sveltejs/kit/pull/16793))

- feat: make `$app/paths` importable in service workers ([#16441](https://github.com/sveltejs/kit/pull/16441))

- feat: pass the project-relative source `filename` to the `preload` filter for fonts ([#16443](https://github.com/sveltejs/kit/pull/16443))

- feat: preserve page state set through `goto(..., { state, persistState: true })` across reloads ([#16449](https://github.com/sveltejs/kit/pull/16449))

- feat: reinstate `$env/static/private`, `$env/dynamic/private`, `$env/static/public`, `$env/dynamic/public` and `$app/environment` as deprecated aliases for `$app/env/private` `$app/env/public` and `$app/env` ([#16334](https://github.com/sveltejs/kit/pull/16334))

- feat: add `page` and `endpoint` booleans to `$app/manifest`'s `routes`, and export a `ManifestRoute` type ([#16594](https://github.com/sveltejs/kit/pull/16594))

- feat: `$app/service-worker` module ([#16458](https://github.com/sveltejs/kit/pull/16458))

- feat: resolve paths using the Vite config `root` option instead of `process.cwd()` to better support monorepo configurations such as Vitest workspaces ([#15469](https://github.com/sveltejs/kit/pull/15469))

- feat: better error logging ([#16374](https://github.com/sveltejs/kit/pull/16374))

- feat: add `PageRouteId` and `EndpointRouteId` to `$app/types` ([#16594](https://github.com/sveltejs/kit/pull/16594))

- feat: better tsconfig validation ([#16458](https://github.com/sveltejs/kit/pull/16458))

- feat: add `dirty()` property to form fields ([#16208](https://github.com/sveltejs/kit/pull/16208))

- feat: support the `QUERY` HTTP method in `+server.js` ([#16782](https://github.com/sveltejs/kit/pull/16782))

- feat: allow adapters to override `getRequest` and `setResponse` during `vite dev` and `vite preview` ([#16753](https://github.com/sveltejs/kit/pull/16753))

- chore: deprecate `Response` helpers in favor of platform-provided alternatives ([#15448](https://github.com/sveltejs/kit/pull/15448))

- feat: add `cookies.parse` method ([#16203](https://github.com/sveltejs/kit/pull/16203))

- chore: deprecate `export const snapshot` in favour of the `snapshot` helper ([#16687](https://github.com/sveltejs/kit/pull/16687))

- feat: add `snapshot` helper to `$app/navigation` ([#16685](https://github.com/sveltejs/kit/pull/16685))

- feat: support custom values in `page.state` via `transport` hook ([#16662](https://github.com/sveltejs/kit/pull/16662))

- fix: default cookies to `secure` to `false` during development ([#16462](https://github.com/sveltejs/kit/pull/16462))

- feat: warn when naively proxying requests that result in responses with a `content-encoding` header ([#16633](https://github.com/sveltejs/kit/pull/16633))

- feat: accept the checked state as a third argument to `.as('radio', ...)` and `.as('checkbox', ...)` so that these inputs reset to it after a submission ([#16926](https://github.com/sveltejs/kit/pull/16926))

- feat: add an `applyReroute` helper for adapters that support split serverless function deployments ([#16665](https://github.com/sveltejs/kit/pull/16665))
