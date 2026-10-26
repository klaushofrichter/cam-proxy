// JSON stored in a catalog column: null when missing or corrupt (one bad row
// must not fail a list); a list, or [] when it is not one.
export const parseStored = (s: string | null): unknown => {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
export const parseStoredList = (s: string | null): unknown[] => {
  const v = parseStored(s);
  return Array.isArray(v) ? v : [];
};
