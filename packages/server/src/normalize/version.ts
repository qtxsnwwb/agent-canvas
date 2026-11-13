/**
 * Version of the normalization rules. The `meta` table stores the version the derived tables were built with;
 * `start` rebuilds when it differs. Bump on any rule change.
 */
export const NORMALIZER_VERSION = 30; // 30: compact edge table (rebuilt from the raw log)
