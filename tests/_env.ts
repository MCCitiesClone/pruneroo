/**
 * Minimal env so modules that validate configuration at import time can load
 * in unit tests. Imported for its side effect, before any module under test.
 */
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5434/db";
process.env.REALTY_BASE_URL ??= "https://realty.example/v1";
process.env.ANALYTICS_BASE_URL ??= "https://analytics.example/v1";
process.env.TREASURY_BASE_URL ??= "https://treasury.example/api/v1";
process.env.PUNISHMENTS_BASE_URL ??= "https://punishments.example";
process.env.INACTIVITY_THRESHOLD_HOURS ??= "6";
