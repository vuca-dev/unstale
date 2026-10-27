# Lane: security

unstale promises it is safe to use with private repositories. Find and fix the highest-ROI security weakness this
week, in this order of concern:

1. **Private repository data leaving the user's machine or being kept.** Anything from a user's repository (paths,
   source, manifests, dependency lists, package names that are not public) reaching the gateway, central, stored
   artifacts, catalog state, Actions logs, Worker logs or analytics. Trace what the CLI (`local/`) sends and what the
   gateway and central store or log. A hosted log in this repository is public.
2. **Prompt injection.** Untrusted text (release notes, docs pages, registry metadata, package names, issue text)
   reaching a model prompt or an agent-facing output (`unstale` review files an agent reads) in a way that can change
   behaviour or exfiltrate data. Includes this repository's own automations.
3. **Dependencies and supply chain.** Vulnerable or unmaintained libraries (`npm audit`, `cargo audit`, advisories),
   unpinned actions or install scripts, over-broad workflow permissions or secrets handed to steps that do not need
   them.
4. Everything else: injection, SSRF in crawling, auth on gateway endpoints, signature checks on the catalog.

Start from what changed since the last run (`git log $BASE_SHA..HEAD` when `BASE_SHA` is set), then widen to the
whole repository. A fix ships with a test that fails without it.
