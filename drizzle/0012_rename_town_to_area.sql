-- `town` became `area`: Willow is not a town, but its plots are exempt from the
-- standard limits in the same way Oakridge's and Aventura's are, so the column
-- needed a name that covers all three.
ALTER TABLE "regions" RENAME COLUMN "town" TO "area";
