// Writes config.schema.json from the settings description (src/config/schema.ts).
// Run after changing a setting: npm run schema
import { writeFileSync } from 'fs';
import { join } from 'path';
import { jsonSchema } from '../src/config/schema';

writeFileSync(join(__dirname, '..', 'config.schema.json'), `${JSON.stringify(jsonSchema(), null, 2)}\n`);
