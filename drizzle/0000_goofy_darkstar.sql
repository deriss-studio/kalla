CREATE TYPE "public"."ai_act_class" AS ENUM('minimal', 'transparency_only', 'high_risk');--> statement-breakpoint
CREATE TYPE "public"."authorship_origin" AS ENUM('machine', 'human', 'machine_then_human');--> statement-breakpoint
CREATE TYPE "public"."cell_state" AS ENUM('empty', 'queued', 'running', 'filled', 'not_found', 'refused', 'expired', 'contested');--> statement-breakpoint
CREATE TYPE "public"."collection_decision" AS ENUM('allowed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."contest_raiser" AS ENUM('user', 'subject', 'reviewer');--> statement-breakpoint
CREATE TYPE "public"."contest_resolution" AS ENUM('upheld', 'corrected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."data_class" AS ENUM('none', 'business', 'personal', 'special');--> statement-breakpoint
CREATE TYPE "public"."declared_use" AS ENUM('market_mapping', 'supplier_screening', 'deal_sourcing', 'competitive_research', 'employment_screening', 'creditworthiness', 'education_access', 'essential_services', 'other');--> statement-breakpoint
CREATE TYPE "public"."dsr_type" AS ENUM('access', 'rectify', 'erase', 'object');--> statement-breakpoint
CREATE TYPE "public"."erasure_state" AS ENUM('active', 'erased');--> statement-breakpoint
CREATE TYPE "public"."proposal_state" AS ENUM('open', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "authorship" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cell_id" uuid NOT NULL,
	"origin" "authorship_origin" NOT NULL,
	"actor_ref" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cell" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"row_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"value" text,
	"state" "cell_state" DEFAULT 'empty' NOT NULL,
	"refusal_reason" text,
	"retention_expires_at" timestamp with time zone,
	"subject_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"decision" "collection_decision" NOT NULL,
	"reason" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "column" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sheet_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"output_type" text DEFAULT 'text' NOT NULL,
	"enum_values" jsonb,
	"model_policy" text DEFAULT 'default' NOT NULL,
	"data_class" "data_class" DEFAULT 'business' NOT NULL,
	"retention_days" integer,
	"source_policy" jsonb,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cell_id" uuid NOT NULL,
	"raised_by" "contest_raiser" NOT NULL,
	"raiser_ref" text,
	"claim" text NOT NULL,
	"counter_evidence" jsonb,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" "contest_resolution",
	"resolved_by_human" text,
	"prior_value" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "dsr" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"subject_id" uuid,
	"type" "dsr_type" NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"response_pack" jsonb
);
--> statement-breakpoint
CREATE TABLE "lia" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sheet_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"purpose" text NOT NULL,
	"necessity" text NOT NULL,
	"balancing" text NOT NULL,
	"mitigations" jsonb,
	"reviewed_by" text,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"canonical_key" text NOT NULL,
	"display_name" text,
	"identifiers" jsonb,
	"lawful_basis" text DEFAULT 'legitimate_interest' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_expires_at" timestamp with time zone,
	"notice_sent_at" timestamp with time zone,
	"notice_language" text,
	"erasure_state" "erasure_state" DEFAULT 'active' NOT NULL,
	"erased_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cell_id" uuid NOT NULL,
	"value" text NOT NULL,
	"evidence" jsonb,
	"state" "proposal_state" DEFAULT 'open' NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text
);
--> statement-breakpoint
CREATE TABLE "provenance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cell_id" uuid NOT NULL,
	"source_url" text NOT NULL,
	"source_domain" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"crawler_id" text NOT NULL,
	"robots_state" text NOT NULL,
	"ai_txt_state" text NOT NULL,
	"model_id" text,
	"model_region" text,
	"confidence" real,
	"quote" text,
	"synthetic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "row_entity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sheet_id" uuid NOT NULL,
	"kind" text DEFAULT 'organisation' NOT NULL,
	"label" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sheet" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"declared_use" "declared_use" NOT NULL,
	"ai_act_class" "ai_act_class" NOT NULL,
	"personal_data_expected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"region_pin" text DEFAULT 'eu' NOT NULL,
	"dpo_contact" text,
	"default_retention_days" integer DEFAULT 180 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authorship" ADD CONSTRAINT "authorship_cell_id_cell_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."cell"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cell" ADD CONSTRAINT "cell_row_id_row_entity_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."row_entity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cell" ADD CONSTRAINT "cell_column_id_column_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."column"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cell" ADD CONSTRAINT "cell_subject_id_person_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_log" ADD CONSTRAINT "collection_log_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "column" ADD CONSTRAINT "column_sheet_id_sheet_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."sheet"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest" ADD CONSTRAINT "contest_cell_id_cell_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."cell"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsr" ADD CONSTRAINT "dsr_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsr" ADD CONSTRAINT "dsr_subject_id_person_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lia" ADD CONSTRAINT "lia_sheet_id_sheet_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."sheet"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_cell_id_cell_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."cell"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provenance" ADD CONSTRAINT "provenance_cell_id_cell_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."cell"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "row_entity" ADD CONSTRAINT "row_entity_sheet_id_sheet_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."sheet"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet" ADD CONSTRAINT "sheet_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "authorship_cell_idx" ON "authorship" USING btree ("cell_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cell_row_column_idx" ON "cell" USING btree ("row_id","column_id");--> statement-breakpoint
CREATE INDEX "cell_subject_idx" ON "cell" USING btree ("subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_domain_idx" ON "collection_log" USING btree ("workspace_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "column_sheet_key_idx" ON "column" USING btree ("sheet_id","key");--> statement-breakpoint
CREATE INDEX "contest_cell_idx" ON "contest" USING btree ("cell_id");--> statement-breakpoint
CREATE INDEX "dsr_subject_idx" ON "dsr" USING btree ("subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lia_sheet_version_idx" ON "lia" USING btree ("sheet_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "person_workspace_key_idx" ON "person" USING btree ("workspace_id","canonical_key");--> statement-breakpoint
CREATE INDEX "proposal_cell_idx" ON "proposal" USING btree ("cell_id");--> statement-breakpoint
CREATE INDEX "provenance_cell_idx" ON "provenance" USING btree ("cell_id");--> statement-breakpoint
CREATE INDEX "row_sheet_idx" ON "row_entity" USING btree ("sheet_id");--> statement-breakpoint
CREATE INDEX "sheet_workspace_idx" ON "sheet" USING btree ("workspace_id");