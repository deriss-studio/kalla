-- The unique keys the composite foreign keys point at must exist before the
-- keys that reference them.
CREATE UNIQUE INDEX "row_id_sheet_idx" ON "row_entity" USING btree ("id","sheet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "column_id_sheet_idx" ON "column" USING btree ("id","sheet_id");--> statement-breakpoint

-- Added nullable and backfilled from the row's own sheet, because a NOT NULL
-- column cannot be added to a table that already holds rows.
ALTER TABLE "cell" ADD COLUMN "sheet_id" uuid;--> statement-breakpoint
UPDATE "cell" c SET "sheet_id" = r."sheet_id" FROM "row_entity" r WHERE r."id" = c."row_id";--> statement-breakpoint
ALTER TABLE "cell" ALTER COLUMN "sheet_id" SET NOT NULL;--> statement-breakpoint

-- The single-column keys are subsumed by the composite ones.
ALTER TABLE "cell" DROP CONSTRAINT "cell_row_id_row_entity_id_fk";--> statement-breakpoint
ALTER TABLE "cell" DROP CONSTRAINT "cell_column_id_column_id_fk";--> statement-breakpoint

-- Any existing cell whose column belongs to a different sheet than its row
-- fails here. That is the point: it is the corruption the constraint exists
-- to prevent, and it should stop the migration rather than survive it.
ALTER TABLE "cell" ADD CONSTRAINT "cell_row_in_sheet_fk" FOREIGN KEY ("row_id","sheet_id") REFERENCES "public"."row_entity"("id","sheet_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cell" ADD CONSTRAINT "cell_column_in_sheet_fk" FOREIGN KEY ("column_id","sheet_id") REFERENCES "public"."column"("id","sheet_id") ON DELETE cascade ON UPDATE no action;
