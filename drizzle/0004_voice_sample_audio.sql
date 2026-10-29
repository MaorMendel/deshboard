ALTER TABLE "voices" ADD COLUMN "sample_audio" "bytea";--> statement-breakpoint
ALTER TABLE "voices" ADD COLUMN "sample_updated_at" timestamp with time zone;