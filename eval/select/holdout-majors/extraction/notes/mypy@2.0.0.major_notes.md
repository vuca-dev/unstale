## Mypy 2.0

We’ve just uploaded mypy 2.0.0 to the Python Package Index ([PyPI](https://pypi.org/project/mypy/)).
Mypy is a static type checker for Python. This release includes new features, performance
improvements and bug fixes. There are also changes to options and defaults.
You can install it as follows:

    python3 -m pip install -U mypy

You can read the full documentation for this release on [Read the Docs](http://mypy.readthedocs.io).

### Enable `--local-partial-types` by Default

This flag affects the inference of types based on assignments in other scopes.
For now, explicitly disabling this continues to be supported, but this support will be removed
in the future as the legacy behaviour is hard to support with other current and future features
in mypy, like the daemon or the new implementation of flexible redefinitions.

Contributed by Ivan Levkivskyi, Jukka Lehtosalo, Shantanu in [PR 21163](https://github.com/python/mypy/pull/21163).

### Enable `--strict-bytes` by Default

Per [PEP 688](https://peps.python.org/pep-0688), mypy no longer treats `bytearray` and `memoryview`
values as assignable to the `bytes` type.

Contributed by Shantanu in [PR 18371](https://github.com/python/mypy/pull/18371).

### New Behavior for `--allow-redefinition`

The `--allow-redefinition` flag now behaves like `--allow-redefinition-new` in mypy 1.20
and earlier. The new behavior is generally more flexible. For example, you can have different
types for a variable in different blocks:

```python
# mypy: allow-redefinition

def foo(cond: bool) -> None:
    if cond:
        for x in ["a", "b"]:
            # Type of "x" is "str" here
            ...
    else:
        for x in [1, 2]:
            # Type of "x" is "int" here
            ...
```

The new behavior requires `--local-partial-types`, which is now enabled by default.

However, `--allow-redefinition` doesn't allow giving two type annotations for the same
variable. The old behavior (sometimes) allows this. Code like this now generates an error
when using `--allow-redefinition`:

```python
def foo() -> None:
    x: list[int] = []
    ...
    x: list[str] = []  # Error: "x" redefined
    ...
```

You can still use `--allow-redefinition-old` to fall back to the old behavior. We have no
plans to remove the legacy behavior, but the old functionality is maintained on a best effort
basis.

Contributed by Jukka Lehtosalo in [PR 21276](https://github.com/python/mypy/pull/21276).

### Parallel Type Checking

Mypy now supports experimental parallel and incremental type checking. Use `--num-workers N`
or `-nN` to use `N` worker processes to type check in parallel. The speedup depends on the
import structure of your codebase and your environment, but for large projects we've seen
performance gains of **up to 5x** when using 8 worker processes.

Parallel type checking implicitly enables the new native parser. There are still some
minor semantic differences between parallel and non-parallel modes, which we will be fixing
in future mypy releases.

Contributed by Ivan Levkivskyi, with additional contributions from Emma Smith and Jukka
Lehtosalo.

Recent related changes since the last release:

- Freeze garbage collection in parallel workers for 4-5% speedup (Ivan Levkivskyi, PR [21302](https://github.com/python/mypy/pull/21302))
- Expose `--num-workers` and `--native-parser` (Ivan Levkivskyi, PR [21387](https://github.com/python/mypy/pull/21387))
- Split type checking into interface and implementation in parallel workers (Ivan Levkivskyi, PR [21119](https://github.com/python/mypy/pull/21119))
- Batch module groups for parallel processing (Ivan Levkivskyi, PR [21287](https://github.com/python/mypy/pull/21287))
- Optimize parallel worker startup (Ivan Levkivskyi, PR [21203](https://github.com/python/mypy/pull/21203))
- Parse files in parallel when possible (Ivan Levkivskyi, PR [21175](https://github.com/python/mypy/pull/21175))
- Use parallel parsing at all stages (Ivan Levkivskyi, PR [21266](https://github.com/python/mypy/pull/21266))
- Fix sequential bottleneck in parallel parsing (Jukka Lehtosalo, PR [21291](https://github.com/python/mypy/pull/21291))
- Fail fast when a user tries to generate reports with parallel workers (Ivan Levkivskyi, PR [21341](https://github.com/python/mypy/pull/21341))
- Partially support old NumPy plugin in parallel type checking (Ivan Levkivskyi, PR [21324](https://github.com/python/mypy/pull/21324))
- Handle reachability consistently in parallel type checking (Ivan Levkivskyi, PR [21322](https://github.com/python/mypy/pull/21322))
- Always respect `@no_type_check` in parallel type checking (Ivan Levkivskyi, PR [21320](https://github.com/python/mypy/pull/21320))
- Minor fixes in parallel checking (Ivan Levkivskyi, PR [21319](https://github.com/python/mypy/pull/21319))
- Fix plugin logic in parallel type checking (Ivan Levkivskyi, PR [21252](https://github.com/python/mypy/pull/21252))
- Fix Windows IPC race condition when using parallel checking (Jukka Lehtosalo, PR [21228](https://github.com/python/mypy/pull/21228))
- Report parallel worker exit status on receive failure (Jukka Lehtosalo, PR [21224](https://github.com/python/mypy/pull/21224))

### Drop Support for Targeting Python 3.9

Mypy no longer supports type checking code with `--python-version 3.9`.
Use `--python-version 3.10` or newer.

Contributed by Shantanu, Marc Mueller in [PR 21243](https://github.com/python/mypy/pull/21243).

### Remove Special Casing of Legacy Bundled Stubs

Mypy used to bundle stubs for a few packages in versions 0.812 and earlier. To navigate the
transition, mypy used to report missing types for these packages even if `--ignore-missing-imports`
was set. Mypy now consistently respects `--ignore-missing-imports` for all packages.

Contributed by Shantanu in [PR 18372](https://github.com/python/mypy/pull/18372).

### Prevent Assignment to None for Non-Optional Class Variables with Type Comments

Mypy used to allow assignment to None for class variables when using type comments. This was a
common idiom in Python 3.5 and earlier, prior to the introduction of variable annotations.
However, this was a soundness hole and has now been removed.

Contributed by Shantanu in [PR 20054](https://github.com/python/mypy/pull/20054).

### librt.strings: String and Bytes Primitives for Mypyc

In mypy 1.20, we introduced [librt](https://pypi.org/project/librt/) as a standard library
for mypyc that fills in some gaps in the Python standard library and the C API.
This release adds the new module `librt.strings`, which contains utilities for building
string and bytes objects, and for accessing and generating binary data:

 * `StringWriter` and `BytesWriter` classes allow quickly building `str` and `bytes` objects
   from parts.
 * `read_*` and `write_*` functions provide fast reading and writing of binary-encoded data.

Refer to the [documentation](https://mypyc.readthedocs.io/en/latest/librt_strings.html) for
the details.

Contributed by Jukka Lehtosalo.

### Mypyc Improvements

- Document `librt.time` (Jukka Lehtosalo, PR [21372](https://github.com/python/mypy/pull/21372))
- Mark `librt.time.time()` non-experimental (Ivan Levkivskyi, PR [21310](https://github.com/python/mypy/pull/21310))
- Fix `librt.time` primitive now that it is no longer experimental (Ivan Levkivskyi, PR [21318](https://github.com/python/mypy/pull/21318))
- Fix `librt` API/ABI version checks (Jukka Lehtosalo, PR [21311](https://github.com/python/mypy/pull/21311))
- Generate more type methods for classes with attribute dictionaries (Piotr Sawicki, PR [21290](https://github.com/python/mypy/pull/21290))
- Fix reference counting for tuple items during deallocation (Shantanu, PR [21245](https://github.com/python/mypy/pull/21245))
- Release new instances when `__init__` raises (Shantanu, PR [21248](https://github.com/python/mypy/pull/21248))
- Fix `@property` getter memory leak (Vaggelis Danias, PR [21230](https://github.com/python/mypy/pull/21230))
- Fix semantics for walrus expression in tuple (Shantanu, PR [21249](https://github.com/python/mypy/pull/21249))
- Fix crash on import errors during cleanup (Shantanu, PR [21247](https://github.com/python/mypy/pull/21247))
- Fix reference leak in str index (Shantanu, PR [21251](https://github.com/python/mypy/pull/21251))
- Fix memory leak in integer true division (Shantanu, PR [21246](https://github.com/python/mypy/pull/21246))
- Fix reference leaks in `list.clear()`/`dict.clear()` (Shantanu, PR [21244](https://github.com/python/mypy/pull/21244))
- Resolve type aliases in function specialization (esarp, PR [21233](https://github.com/python/mypy/pull/21233))
- Report an error if an acyclic class inherits from non-acyclic (Piotr Sawicki, PR [21227](https://github.com/python/mypy/pull/21227))
- Fix `b64decode` to match new CPython behavior (Piotr Sawicki, PR [21200](https://github.com/python/mypy/pull/21200))

### Fixes to Crashes

- Fix crash when a file does not exist during semantic analysis (Ivan Levkivskyi, PR [21379](https://github.com/python/mypy/pull/21379))
- Fix parallel worker crash on syntax error (Ivan Levkivskyi, PR [21202](https://github.com/python/mypy/pull/21202))

### Changes to Messages

- Improve error messages for unexpected keyword arguments in overloaded functions (Kevin Kannammalil, PR [20592](https://github.com/python/mypy/pull/20592))
- Don't suggest `Foo[...]` when `Foo(arg=...)` is used in annotation (Yosof Badr, PR [21238](https://github.com/python/mypy/pull/21238))
- Mention what codes are actually ignored in "not covered by type: ignore comment" note (wyattscarpenter, PR [19904](https://github.com/python/mypy/pull/19904))
- Improve error messages when positional argument is missing (Kevin Kannammalil, PR [20591](https://github.com/python/mypy/pull/20591))
- Improve "name is not defined" errors with fuzzy matching (Kevin Kannammalil, PR [20693](https://github.com/python/mypy/pull/20693))
- Add suggestions for misspelled module imports (Kevin Kannammalil, PR [20695](https://github.com/python/mypy/pull/20695))

### Performance Improvements

- Replace `NamedTuple` with faster regular classes in hot paths (Shantanu, PR [21326](https://github.com/python/mypy/pull/21326))
- Avoid calling best-match suggestions unless the message is shown (Ivan Levkivskyi, PR [21307](https://github.com/python/mypy/pull/21307))
- Order cases in native parser based on AST node frequency (Jukka Lehtosalo, PR [21219](https://github.com/python/mypy/pull/21219))

### Stubtest Improvements

- Basic support for unpack kwargs (Shantanu, PR [21024](https://github.com/python/mypy/pull/21024))
- Fix false positive for properties with a deleter (Pranav Manglik, PR [21259](https://github.com/python/mypy/pull/21259))

### Documentation Updates

- Rename "value restriction" to "value-constrained type variable" (Leo Ji, PR [21112](https://github.com/python/mypy/pull/21112))
- Clarify that invariant-by-default applies to legacy `TypeVar` syntax (Leo Ji, PR [21108](https://github.com/python/mypy/pull/21108))

### Improvements to the Native Parser

The new native parser is still experimental.

- Make new parser consistent with the old one (Ivan Levkivskyi, PR [21377](https://github.com/python/mypy/pull/21377))
- Support `--package-root` with the native parser (Ivan Levkivskyi, PR [21321](https://github.com/python/mypy/pull/21321))
- Improve call expressions in type annotations with the native parser (Jukka Lehtosalo, PR [21300](https://github.com/python/mypy/pull/21300))
- Depend on `ast-serialize` by default (Jukka Lehtosalo, PR [21297](https://github.com/python/mypy/pull/21297))

### Other Notable Fixes and Improvements

- Fix narrowing for `AbstractSet` and `Mapping` (Shantanu, PR [21352](https://github.com/python/mypy/pull/21352))
- Preserve gradual guarantee when narrowing `Any` union via equality (Shantanu, PR [21368](https://github.com/python/mypy/pull/21368))
- Make type variable upper bound narrowing symmetric (Ivan Levkivskyi, PR [21350](https://github.com/python/mypy/pull/21350))
- Behave consistently when type-checking a stub package directly (Ivan Levkivskyi, PR [21330](https://github.com/python/mypy/pull/21330))
- Add support for `Final[...]` in dataclasses (Ivan Levkivskyi, PR [21334](https://github.com/python/mypy/pull/21334))
- Narrow more sequence parents (Shantanu, PR [21327](https://github.com/python/mypy/pull/21327))
- Better narrowing for enums and other types with known equality (Shantanu, PR [21281](https://github.com/python/mypy/pull/21281))
- Fix pathspec error (Ivan Levkivskyi, PR [21296](https://github.com/python/mypy/pull/21296))
- Use sharding for the SQLite cache (Jukka Lehtosalo, PR [21292](https://github.com/python/mypy/pull/21292))
- Limit type inference context fallback to the walrus operator only (Ivan Levkivskyi, PR [21294](https://github.com/python/mypy/pull/21294))
- Support `.git/info/exclude` for `--exclude-gitignore` (RogerJinIS, PR [21286](https://github.com/python/mypy/pull/21286))
- Let `--allow-redefinition` widen a global in a function with `None` initialization (Jukka Lehtosalo, PR [21285](https://github.com/python/mypy/pull/21285))
- Delete Python 2 extra (Shantanu, PR [18374](https://github.com/python/mypy/pull/18374))
- No longer narrow final globals in functions (Ivan Levkivskyi, PR [21241](https://github.com/python/mypy/pull/21241))
- Narrow unions containing `Any` in conditional branches (Shantanu, PR [21231](https://github.com/python/mypy/pull/21231))
- Propagate narrowing within chained comparisons (Shantanu, PR [21160](https://github.com/python/mypy/pull/21160))
- Add proper lazy deserialization (Ivan Levkivskyi, PR [21198](https://github.com/python/mypy/pull/21198))
- Add `install_types` to options affecting cache (Brian Schubert, PR [21070](https://github.com/python/mypy/pull/21070))
- Narrow `Any` in conditional type checks (Shantanu, PR [21167](https://github.com/python/mypy/pull/21167))
- Fix exception handler target location in new parser (Ivan Levkivskyi, PR [21185](https://github.com/python/mypy/pull/21185))
- Improve traceback display (Shantanu, PR [21155](https://github.com/python/mypy/pull/21155))
- Include two more files in the sdist: `CREDITS` and the typeshed `README` (Michael R. Crusoe, PR [21131](https://github.com/python/mypy/pull/21131))

### Typeshed Updates

Please see [git log](https://github.com/python/typeshed/commits/main?after=c5e47faeda2cf9d233f91bc1dc95814b0cc7ccba+0&branch=main&path=stdlib) for full list of standard library typeshed stub changes.

### Acknowledgements

Thanks to all mypy contributors who contributed to this release:
- Brian Schubert
- Ethan Sarp
- Ivan Levkivskyi
- Jukka Lehtosalo
- Kevin Kannammalil
- Leo Ji
- Marc Mueller
- Michael R. Crusoe
- Piotr Sawicki
- Pranav Manglik
- RogerJinIS
- Shantanu
- Vaggelis Danias
- wyattscarpenter
- Yosof Badr

I’d also like to thank my employer, Dropbox, for supporting mypy development.
