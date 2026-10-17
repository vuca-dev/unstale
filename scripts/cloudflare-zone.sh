#!/usr/bin/env bash
# Zone settings for unstale.sh that the Worker deploy does not cover, applied idempotently through the Cloudflare API
# (run by .github/workflows/zone.yml; needs CLOUDFLARE_API_TOKEN with Zone Settings, DNS, Zone (DNSSEC) and Single
# Redirect edit on the zone). Every step runs even if an earlier one is refused; the exit code says whether all held.
#
# - HTTPS only: Always Use HTTPS, TLS 1.2 minimum, TLS 1.3, automatic HTTPS rewrites.
# - DNSSEC on (Cloudflare Registrar publishes the DS record itself).
# - CAA: only the CAs Cloudflare's edge certificates come from may issue for the domain.
# - Mail: the domain sends no mail, so SPF `-all` and DMARC `reject` stop anyone sending as it.
# - www.unstale.sh: a proxied placeholder record and a 301 to the apex, path and query kept.
set -uo pipefail
ZONE_NAME="${ZONE_NAME:-unstale.sh}"
API="https://api.cloudflare.com/client/v4"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
failed=0

cf() { # cf METHOD PATH [JSON]: prints the response; returns 1 unless .success
  local out
  out="$(curl -sS -X "$1" "$API$2" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" ${3:+--data "$3"})"
  echo "$out"
  [ "$(jq -r '.success' <<<"$out" 2>/dev/null)" = "true" ]
}
step() { # step NAME METHOD PATH [JSON]
  local name="$1"; shift
  if out="$(cf "$@")"; then echo "ok    $name"; else echo "FAIL  $name: $(jq -c '.errors' <<<"$out" 2>/dev/null || echo "$out")"; failed=1; fi
}

zone="$(cf GET "/zones?name=$ZONE_NAME" | jq -r '.result[0].id // empty')"
[ -n "$zone" ] || { echo "FAIL  zone $ZONE_NAME not found or not readable with this token"; exit 1; }

for setting in 'always_use_https:"on"' 'min_tls_version:"1.2"' 'tls_1_3:"on"' 'automatic_https_rewrites:"on"'; do
  step "setting ${setting%%:*}" PATCH "/zones/$zone/settings/${setting%%:*}" "{\"value\":${setting#*:}}"
done
step "dnssec" PATCH "/zones/$zone/dnssec" '{"status":"active"}'

# upsert TYPE NAME JSON: creates the record unless one with the same type, name and content exists.
upsert() {
  local type="$1" name="$2" body="$3" content
  content="$(jq -r '.content // (.data | tostring)' <<<"$body")"
  existing="$(cf GET "/zones/$zone/dns_records?type=$type&name=$name&per_page=100" | jq -r --arg c "$content" \
    '[.result[] | select((.content // (.data | tostring)) == $c)] | length')"
  if [ "${existing:-0}" -gt 0 ]; then echo "ok    $type $name (present)"; else step "$type $name" POST "/zones/$zone/dns_records" "$body"; fi
}
for ca in pki.goog letsencrypt.org ssl.com; do
  for tag in issue issuewild; do
    upsert CAA "$ZONE_NAME" "{\"type\":\"CAA\",\"name\":\"$ZONE_NAME\",\"data\":{\"flags\":0,\"tag\":\"$tag\",\"value\":\"$ca\"}}"
  done
done
upsert TXT "$ZONE_NAME" "{\"type\":\"TXT\",\"name\":\"$ZONE_NAME\",\"content\":\"\\\"v=spf1 -all\\\"\"}"
upsert TXT "_dmarc.$ZONE_NAME" "{\"type\":\"TXT\",\"name\":\"_dmarc.$ZONE_NAME\",\"content\":\"\\\"v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s\\\"\"}"
upsert AAAA "www.$ZONE_NAME" "{\"type\":\"AAAA\",\"name\":\"www.$ZONE_NAME\",\"content\":\"100::\",\"proxied\":true}"

# The www redirect: one rule, identified by its description, merged into the zone's redirect rules.
phase="/zones/$zone/rulesets/phases/http_request_dynamic_redirect/entrypoint"
desc="www to apex"
rule="$(jq -cn --arg host "www.$ZONE_NAME" --arg apex "https://$ZONE_NAME" --arg d "$desc" '{
  description: $d, expression: "(http.host eq \"\($host)\")", action: "redirect",
  action_parameters: { from_value: { status_code: 301, preserve_query_string: true,
    target_url: { expression: "concat(\"\($apex)\", http.request.uri.path)" } } } }')"
current="$(cf GET "$phase" | jq -c '.result.rules // []' 2>/dev/null || echo '[]')"
rules="$(jq -c --arg d "$desc" --argjson r "$rule" '[.[] | select(.description != $d) | {description, expression, action, action_parameters, enabled}] + [$r]' <<<"$current")"
step "redirect www.$ZONE_NAME -> $ZONE_NAME" PUT "$phase" "{\"rules\":$rules}"

exit "$failed"
