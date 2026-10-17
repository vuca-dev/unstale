#!/usr/bin/env bash
# Operator-only local central service. Never bundled into the client package.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
port="${UNSTALE_PORT:-47831}"
case "${1:-start}" in
 start)
  if curl --fail --silent "http://127.0.0.1:$port/health" >/dev/null; then
   echo "Central already running at http://127.0.0.1:$port"; exit 0
  fi
  mkdir -p "$root/.store"
  node - "$root" "$port" <<'JS'
const {spawn}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');
const [root,port]=process.argv.slice(2);const log=fs.openSync(path.join(root,'.store/onboarding-central.log'),'a');
const child=spawn(process.execPath,['--import',require.resolve('tsx',{paths:[path.join(root,'central')]}),path.join(root,'central/src/onboarding/cli.ts')],{cwd:path.join(root,'central'),env:{...process.env,UNSTALE_PORT:port},detached:true,stdio:['ignore',log,log]});
fs.writeFileSync(path.join(root,'.store/onboarding-central.pid'),String(child.pid));child.unref();fs.closeSync(log);
JS
  for attempt in $(seq 1 50); do
   if curl --fail --silent "http://127.0.0.1:$port/health" >/dev/null; then
    echo "Central ready at http://127.0.0.1:$port; jobs persist in .store/central/onboarding"
    echo "Operator log: $root/.store/onboarding-central.log"; exit 0
   fi
   sleep 0.1
  done
  echo "Central did not start; see $root/.store/onboarding-central.log" >&2; exit 1
  ;;
 stop)
  node - "$root" <<'JS'
const fs=require('node:fs'),path=require('node:path');const file=path.join(process.argv[2],'.store/onboarding-central.pid');
if(fs.existsSync(file)){const pid=Number(fs.readFileSync(file,'utf8'));try{process.kill(pid,'SIGTERM');console.log('Central stopped; persisted jobs resume on restart.');}catch(e){if(e.code!=='ESRCH')throw e;}fs.unlinkSync(file);}
JS
  ;;
 *) echo 'Usage: scripts/dev-central.sh [start|stop]' >&2; exit 2 ;;
esac
