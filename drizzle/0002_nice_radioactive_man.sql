ALTER TABLE "row_entity" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
ALTER TABLE "row_entity" ADD CONSTRAINT "row_entity_subject_id_person_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "row_subject_idx" ON "row_entity" USING btree ("subject_id");