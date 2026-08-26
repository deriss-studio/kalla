CREATE TYPE "public"."subject_uncertainty" AS ENUM('ambiguous_identity', 'context_without_identity');--> statement-breakpoint
ALTER TABLE "cell" ADD COLUMN "subject_uncertainty" "subject_uncertainty";