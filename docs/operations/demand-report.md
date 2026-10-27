# Coverage demand report

The `demand-report` Actions workflow reads the authenticated `/internal/demand` endpoint daily at 07:10 UTC and on manual dispatch. It uses the existing `GATEWAY_DRAIN_TOKEN` secret and `UNSTALE_DEFAULT_SERVICE` variable, defaulting to `https://api.unstale.sh`. Deploy the gateway change before running the workflow; an older gateway fails the report rather than reporting zero demand.

The Actions summary shows the latest 14 observed UTC days; the service retains today and the previous 89 UTC days. Collection starts at deployment's first object access. The first day and current day are partial. There is no backfill from the old SQL-operation counters. Days absent from history are unknown, not zero. History is pruned on access; an idle object's last persisted snapshot is pruned on its next access.

Each submitted package gets one outcome after identity validation:

- Accepted: a previously unheld package entered the queue. This is not a unique package over the entire day: an acknowledged package can be registered again.
- Vote counted: an existing or held package gained one demand vote.
- Duplicate: the existing in-memory requester/package deduplicator suppressed another vote.
- Vote limited: the address or global vote allowance suppressed a vote.
- Refused: the address allowance, hourly new-package allowance, or pending-queue cap prevented admission.
- Package not found: the registry returned 404.
- Registry unavailable: the public registry could not confirm the package.

Malformed requests rejected before package validation are excluded. A batch contributes one outcome per submitted package, not one per HTTP request. The HTTP responses and queue behavior remain the same.

The two reporting categories are **unmarked** and **marked internal**. Internal attribution is explicitly configured in the operator's local Scout/evaluation runners, rather than advertised in CLI help, generated skills, or user setup instructions. It is self-declared and affects reporting only: no authentication, rate-limit exemption, admission priority, or separate demand votes. Unmarked traffic includes bots and internal clients that have not been configured; neither category counts people. Historical traffic cannot be attributed retroactively, and a rebuilt CLI is required for configured Scout runners to send the marker.

Daily counts contain no addresses, address hashes, package names, repository context, client IDs, request headers, or event histories. They share the queue's existing usage snapshot and bounded flush (45 seconds, or after idle); a crash can lose unflushed outcomes. Per-package deduplication is in memory and resets on object eviction. This is best-effort service demand measurement, not exact accounting or an install/retention metric.

`/internal/usage` includes today's demand counts for existing ingestion snapshots. The dedicated `/internal/demand` endpoint includes retained aggregate history, preventing every ingest cycle from printing the full history. Both require the existing drain bearer token. Keep reports aggregate-only: do not add queue contents or request metadata to public Actions output.
