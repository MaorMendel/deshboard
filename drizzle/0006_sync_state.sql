CREATE TABLE IF NOT EXISTS "sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"covered_from" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone NOT NULL
);
