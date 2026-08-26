CREATE TABLE "expiry_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"cell_id" uuid NOT NULL,
	"sheet_id" uuid NOT NULL,
	"had_subject" boolean DEFAULT false NOT NULL,
	"retention_expired_at" timestamp with time zone NOT NULL,
	"swept_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expiry_log" ADD CONSTRAINT "expiry_log_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expiry_workspace_idx" ON "expiry_log" USING btree ("workspace_id");