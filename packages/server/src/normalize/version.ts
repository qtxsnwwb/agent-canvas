/**
 * Version of the normalization rules. The `meta` table stores the version the derived tables were built with;
 * `start` rebuilds when it differs. Bump on any rule change.
 */
export const NORMALIZER_VERSION = 34; // 31: inputKey; 32: over the whole input, type-tagged; 33: a Cursor key carried in the record state; 34: Cursor result content ids in the key
