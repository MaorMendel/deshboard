CREATE TABLE IF NOT EXISTS "response_presets" (
	"scope" text PRIMARY KEY NOT NULL,
	"fast" jsonb,
	"patient" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
