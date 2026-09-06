-- Chest-shop data is removed: nothing ever read `chestshop_shops` — no view,
-- insight or page queried it — and the firm discovery it was built to feed was
-- never implemented (`firms` never held a row). The crawl cost ~42% of the
-- treasury request budget and starved the prune backfill for a serial job slot.
DROP TABLE "chestshop_shops" CASCADE;
-- The probe watermark has nothing left to gate.
DELETE FROM "sync_watermarks" WHERE "source" = 'treasury' AND "key" = 'chestshop.fingerprint';

-- Retire queued or historical chest-shop jobs so no handler is looked up for a
-- kind that no longer exists.
DELETE FROM "sync_jobs" WHERE "kind" LIKE 'treasury.chestshop%';
