import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('the Clips page', () => {
  // MB in the admin UI is 1024² (format.ts mbText), as on Storage and the Archive.
  it("sizes a clip with the UI's MB, not 10⁶ bytes", () => {
    const page = readFileSync(join(__dirname, '../web/src/pages/Clips.svelte'), 'utf8');
    expect(page).toMatch(/import \{[^}]*\bmbText\b[^}]*\} from '\.\.\/lib\/format'/);
    expect(page).toContain('{mbText(c.size)}');
    expect(page).not.toContain('1e6');
  });
});
