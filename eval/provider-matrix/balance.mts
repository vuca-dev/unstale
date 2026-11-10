// Prints the gateway's live balance; exits 1 below --min (the run script's stop rule, PREREG.md "Budget").
//   cd central && npx tsx ../eval/provider-matrix/balance.mts [--min 2.0]
import { join } from "node:path";
const { gatewayBalance } = await import(join(import.meta.dirname, "..", "select", "budget.ts"));
const b = await gatewayBalance();
const i = process.argv.indexOf("--min");
const min = i > 0 ? Number(process.argv[i + 1]) : 0;
console.log(`gateway balance $${b.toFixed(4)}${min ? ` (stop below $${min})` : ""}`);
process.exit(b < min ? 1 : 0);
