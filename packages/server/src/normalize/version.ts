/**
 * Version of the normalization rules. The `meta` table stores the version the derived tables were built with;
 * `start` rebuilds when it differs. Bump on any rule change.
 */
export const NORMALIZER_VERSION = 33; // 31: inputKey on tool and dispatch nodes; 32: inputKey over the whole input, type-tagged; 33: a Cursor key carried in the record state
