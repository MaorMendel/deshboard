CREATE TYPE "public"."actor_type" AS ENUM('link', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."call_status" AS ENUM('queued', 'in_progress', 'ended', 'failed');--> statement-breakpoint
CREATE TYPE "public"."call_type" AS ENUM('inbound', 'outbound', 'test');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."tenant_type" AS ENUM('customer', 'demo');--> statement-breakpoint
CREATE TYPE "public"."voice_gender" AS ENUM('female', 'male');--> statement-breakpoint
CREATE TYPE "public"."voice_tier" AS ENUM('standard', 'premium');--> statement-breakpoint
CREATE TABLE "access_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "access_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_link_id" uuid,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"settings" jsonb NOT NULL,
	"vapi_payload" jsonb,
	"created_by_type" "actor_type" NOT NULL,
	"created_by_link_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vapi_call_id" text,
	"type" "call_type" NOT NULL,
	"status" "call_status" DEFAULT 'queued' NOT NULL,
	"vapi_assistant_id" text,
	"customer_number" text,
	"version_id" uuid,
	"test_settings" jsonb,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"cost_usd" numeric(10, 4),
	"ended_reason" text,
	"summary" text,
	"transcript" text,
	"recording_url" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_vapi_call_id_unique" UNIQUE("vapi_call_id"),
	CONSTRAINT "calls_duration_non_negative" CHECK ("calls"."duration_seconds" is null or "calls"."duration_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_customer_id" text,
	"name" text NOT NULL,
	"type" "tenant_type" DEFAULT 'customer' NOT NULL,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"demo_seconds_limit" integer,
	"demo_expires_at" timestamp with time zone,
	"vapi_assistant_id" text,
	"vapi_phone_number_id" text,
	"bot_phone_display" text,
	"verified_phone" text,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_external_customer_id_unique" UNIQUE("external_customer_id"),
	CONSTRAINT "tenants_demo_fields" CHECK ("tenants"."type" <> 'demo' or ("tenants"."demo_seconds_limit" is not null and "tenants"."demo_expires_at" is not null)),
	CONSTRAINT "tenants_verified_phone_e164" CHECK ("tenants"."verified_phone" is null or "tenants"."verified_phone" ~ '^\+[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "voices" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"gender" "voice_gender" NOT NULL,
	"description" text NOT NULL,
	"provider" text NOT NULL,
	"provider_voice_id" text NOT NULL,
	"sample_url" text,
	"tier" "voice_tier" DEFAULT 'standard' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_links" ADD CONSTRAINT "access_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_link_id_access_links_id_fk" FOREIGN KEY ("actor_link_id") REFERENCES "public"."access_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_versions" ADD CONSTRAINT "bot_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_versions" ADD CONSTRAINT "bot_versions_created_by_link_id_access_links_id_fk" FOREIGN KEY ("created_by_link_id") REFERENCES "public"."access_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_version_id_bot_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."bot_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_current_version_id_bot_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."bot_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_links_tenant" ON "access_links" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_created" ON "audit_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_versions_tenant_version" ON "bot_versions" USING btree ("tenant_id","version");--> statement-breakpoint
CREATE INDEX "calls_tenant_started" ON "calls" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "calls_tenant_created" ON "calls" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_one_active_test" ON "calls" USING btree ("tenant_id") WHERE "calls"."type" = 'test' and "calls"."status" in ('queued', 'in_progress');