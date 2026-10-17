# Labelling packet: record classifier (held-out)

Each item in `classify/packet-records.json` is one change record exactly as the pipeline's classifier sees it (its
`state`: technology, source, release, subject, summary, the verbatim evidence quote and section, what it introduces
and replaces). Judge each record from its `state` alone. Do not look at any model's labels, the unstale catalog, the
release notes behind the record, `records.json`, or other labelers' files. There are 233 records, shuffled.

If a record does not describe a real change (garbled, or not a change at all), still answer every field from what
the record says, and add `"note": "not a change"`.

## Questions

1. **`breaking`** (true/false), by the pipeline's rubric (`BREAKING_RUBRIC`, verbatim):

> BREAKING (yes) means: a project that worked on the previous version, upgraded to this release with no change to its code, configuration, scripts or tooling, then fails (an error, a failed build or type check, a command that no longer exists) or behaves differently in a way its users or developers would notice. Raising a minimum supported version of a runtime or dependency is breaking. A removal is breaking.
> NOT BREAKING (no) includes: a new optional feature or option; a deprecation that still works (a warning only); a recommendation or optional modernisation ("we recommend", "you may", "not required", new project defaults that existing projects need not adopt); a fix that restores documented behaviour; documentation changes.
> Judge what the change does to existing code, not where it is listed. If the source does not show that existing code stops working or changes behaviour, answer no.

2. **`benefit`**: the list of benefits this change brings to a project that uses it, or `["none"]`. Definitions
   (`BENEFIT_DEFS`, verbatim):

- `security`: Closes a vulnerability, or hardens a default or an API against misuse or attack.
- `correctness`: Prevents wrong results, data loss, crashes, hangs or other bugs in a project that uses this.
- `performance`: Makes a project faster, or use less memory, CPU, network, queries or bundle size.
- `cost`: Lowers what running the project costs (compute, storage, paid API usage, infrastructure).
- `maintainability`: Replaces code a project would otherwise write and maintain itself (a hand-rolled helper, workaround or wrapper, or a third-party package used for the same job) with a supported built-in. Only when the record names, or `replaces` lists, what it supersedes; not for a new capability, and not for a rename.

   Rule for every benefit (`BENEFIT_RULE`, verbatim):

   > Answer yes only where the record's summary or evidence states this benefit, or it is the documented purpose of the feature. Do not infer gains the source does not claim. New conveniences, ergonomics, naming, style, type-only changes, tooling preferences, optional modernisation and new capabilities without this benefit are no.

3. **`change_type`**: exactly one (`CHANGE_TYPES`, verbatim):

- `new_api`: A new function, class, component, hook, module, command or file convention that did not exist before.
- `new_option`: A new option, flag, parameter, argument or configuration key on something that already exists.
- `behavior_change`: Existing code or configuration now behaves differently at run time or build time (not only a default value, not a bug fix).
- `default_change`: The default value of an existing option, setting or mode changed.
- `fix`: A bug fix: wrong results, crashes, errors or regressions corrected, restoring intended or documented behaviour.
- `deprecation`: Something still works but is marked for future removal (a warning, a deprecation notice).
- `removal`: Something that existed was removed or no longer works, including dropped support for a runtime or platform version.
- `stability_change`: An API or feature moved between experimental, preview, beta, unstable and stable.
- `performance`: Faster, or less memory, CPU, network, queries or bundle size, with nothing new to write.
- `security`: Closes a vulnerability or hardens a default or an API against misuse or attack.
- `tooling`: Developer tooling: the CLI, build tooling, codemods, dev server, type generation, test or editor tooling.
- `other`: None of the above.

4. **`actionable`** (true/false): is there anything for a project to write or change for this record? `false`
   means the change only alters how running code behaves and a project has nothing to write, configure, run or
   change for it (the pipeline's `runtime_internal` surface: "Running code behaves differently; there is nothing for a project to write.").

## Output

`classify/labels/<labeler>.json`, with every id as a key:

```json
{
  "<id>": {"breaking": false, "benefit": ["none"], "change_type": "fix", "actionable": false},
  "<id>": {"breaking": true, "benefit": ["correctness"], "change_type": "removal", "actionable": true}
}
```
