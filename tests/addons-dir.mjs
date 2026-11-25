// Where the tests find the add-ons: the private add-on repository checked out next to this one
// (../salotto-addons, or ADDONS_DIR), the same folder server.js serves at /addons/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ADDONS = path.resolve(process.env.ADDONS_DIR || path.join(ROOT, '..', 'salotto-addons'));
if (!fs.existsSync(path.join(ADDONS, 'repository.json'))) {
  console.error(`Questi test usano gli add-on privati: clona gbagliesi/salotto-addons in ${ADDONS} (o imposta ADDONS_DIR).`);
  process.exit(2);
}
