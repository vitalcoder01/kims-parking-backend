-- Visitors are patients — "purpose of visit" isn't a meaningful field for them.
ALTER TABLE "visitors" DROP COLUMN "purpose";
