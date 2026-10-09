/** Test-only subprocess: stop and restart the actual A/B runtime like Ctrl+C. */
import { startShoppingDemo } from '../../scripts/shopping-demo';

const [directory, rawShoppingPort, rawMerchantPort] = process.argv.slice(2);
if (!directory || rawShoppingPort === undefined || rawMerchantPort === undefined) throw new Error('Use merchant-browser-server.ts');
const demo = await startShoppingDemo({ dataDir: directory, shoppingPort: Number(rawShoppingPort),
  merchantPort: Number(rawMerchantPort), env: {} });
console.log(JSON.stringify({ shoppingOrigin: demo.shoppingOrigin, merchantOrigin: demo.merchantOrigin,
  demoPortalUrl: demo.demoPortalUrl, userDemoUrl: demo.userDemoUrl, merchantDemoUrl: demo.merchantDemoUrl }));
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void demo.stop().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
};
process.on('SIGINT', close); process.on('SIGTERM', close);
// Windows subprocess SIGTERM may terminate without dispatching JS handlers.
// A private stdin command requests the same awaited shutdown as the CLI.
for await (const chunk of process.stdin) {
  if (chunk.toString().trim() === 'stop') { close(); break; }
}
