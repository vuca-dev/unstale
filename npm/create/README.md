# @unstale/create

**You don't know what you don't know. Neither does your agent.**

Sets up [unstale](https://github.com/vuca-dev/unstale) in the current repository:

```sh
npm init @unstale
```

This is the same as `npx @unstale/cli init`: it runs `unstale init` from [`@unstale/cli`](https://www.npmjs.com/package/@unstale/cli),
the package that holds the tool. Options after `--` are passed on, for example `npm init @unstale -- --mode local`.

To keep `unstale` on your PATH for later commands (`unstale status`, `unstale run`), install it once with
`npm install -g @unstale/cli` or `brew install vuca-dev/tap/unstale`.

Documentation and source: [github.com/vuca-dev/unstale](https://github.com/vuca-dev/unstale). Licensed under
AGPL-3.0-only.
