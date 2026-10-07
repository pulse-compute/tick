import { runReferenceBurst } from './reference.mjs';
if (process.argv.length !== 2) throw new Error('Usage: node proof/trigger/burst.mjs');
console.log(JSON.stringify(await runReferenceBurst(), null, 2));
