// Run the scheduled job once from the command line: `npm run monitor` (e.g. from system cron).
import { syncAllConnections } from "../src/lib/email/sync";
import { runMonitor } from "../src/lib/monitor";

const mailboxes = await syncAllConnections();
const prices = await runMonitor();
console.log(JSON.stringify({ mailboxes, prices }, null, 2));
