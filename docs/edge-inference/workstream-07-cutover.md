# WS7: Release, grace period, cutover

**Out of scope for the sprint run:** the CEO runs the release and the cutover. Agents may publish to npm and
Homebrew only when a test needs a published build to validate work.

## Scope
Ship the client, run the 20-day grace period, then stop central's model steps.

## Pre-conditions
WS1–WS6, WS9 and WS10 merged and verified; WS8 reviewed. The release turns the README's one switch on by default.

## Steps
1. **Release:** bump the client version and tag in the same change, so `latest_client` never announces an unpublished
   version.
2. **Day 0:** publish a notice (`central/notice.json`) with the day-20 date, and tell current users directly; clients
   before #213 cannot show notices.
3. **Days 0–20:** central keeps its model steps, so every client stays correct.
4. **Day 20:**
   - raise `min_client` to the new release;
   - central stops A+B, D and E and publishes change events only;
   - the records catalog is frozen.

## Acceptance criteria
- [ ] Old clients print the `min_client` refusal and keep their cached catalog (checked against the previous release
      binary).
- [ ] Central's scheduled runs make no model calls after day 20 (usage logs at zero).
- [ ] New clients on every supported provider produce records for a fresh repo end to end.

## Risks and rollback
Rollback for day 20: lower `min_client` and re-enable central's model steps; both are configuration.
