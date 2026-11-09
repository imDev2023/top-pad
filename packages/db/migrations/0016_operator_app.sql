CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"operator" text NOT NULL,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"detail" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "launch_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"ticker" text NOT NULL,
	"name" text NOT NULL,
	"image_sha256" text,
	"decision" text NOT NULL,
	"note" text NOT NULL,
	"operator" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vamp_clearances" (
	"creator_id" uuid NOT NULL,
	"field" text NOT NULL,
	"value" text NOT NULL,
	"review_id" uuid NOT NULL,
	"cleared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vamp_clearances_creator_id_field_value_pk" PRIMARY KEY("creator_id","field","value")
);
--> statement-breakpoint
CREATE TABLE "wallet_clearances" (
	"wallet" text PRIMARY KEY NOT NULL,
	"note" text NOT NULL,
	"operator" text NOT NULL,
	"cleared_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admission_reviews" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "admission_reviews" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "linkage_hubs" ADD COLUMN "added_by" text;--> statement-breakpoint
ALTER TABLE "vamp_appeals" ADD COLUMN "decided_by" text;--> statement-breakpoint
ALTER TABLE "vamp_appeals" ADD COLUMN "review_id" uuid;--> statement-breakpoint
ALTER TABLE "launch_reviews" ADD CONSTRAINT "launch_reviews_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vamp_clearances" ADD CONSTRAINT "vamp_clearances_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vamp_clearances" ADD CONSTRAINT "vamp_clearances_review_id_launch_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."launch_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "launch_reviews_launch_idx" ON "launch_reviews" USING btree ("creator_id","ticker","name");--> statement-breakpoint
ALTER TABLE "vamp_appeals" ADD CONSTRAINT "vamp_appeals_review_id_launch_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."launch_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The audit log is append-only for every role (spec 10.2): the owner of the table, whom the API connects as, included.
CREATE FUNCTION "audit_log_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the audit log is append-only: % is refused', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;--> statement-breakpoint
CREATE TRIGGER "audit_log_no_update_or_delete" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION "audit_log_append_only"();--> statement-breakpoint
CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION "audit_log_append_only"();--> statement-breakpoint
-- `heat_operator`, the role every statement of the operator app runs as (apps/operator): it reads the queue, records the
-- operator's decisions and writes the audit log, which it may insert into and read but never update or delete (spec
-- 10.2). Roles belong to the whole server, not one database, so it is made once and kept: every test database's
-- migration finds it there, and two made at once meet each other here. It cannot log in; the operator app's connection
-- takes it on with `SET LOCAL ROLE` for each transaction, so the connecting role must be able to SET it.
DO $$
BEGIN
  CREATE ROLE "heat_operator" NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END
$$;--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('GRANT "heat_operator" TO %I WITH INHERIT FALSE, SET TRUE', current_user);
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA "public" TO "heat_operator";--> statement-breakpoint
GRANT SELECT ON "vamp_checks", "vamp_appeals", "creators", "creator_wallets", "launches", "admission_reviews", "linkage_hubs", "bundle_cases", "launch_reviews", "vamp_clearances", "wallet_clearances", "job_runs" TO "heat_operator";--> statement-breakpoint
GRANT INSERT, SELECT ON "audit_log" TO "heat_operator";--> statement-breakpoint
GRANT INSERT ON "launch_reviews", "vamp_clearances", "wallet_clearances" TO "heat_operator";--> statement-breakpoint
GRANT INSERT, DELETE ON "linkage_hubs" TO "heat_operator";--> statement-breakpoint
GRANT UPDATE ("status", "decided_at", "decided_by", "review_id") ON "vamp_appeals" TO "heat_operator";--> statement-breakpoint
GRANT UPDATE ("resolved_at", "resolution", "resolved_by") ON "admission_reviews" TO "heat_operator";--> statement-breakpoint
-- The job runner's records, for the daily export to R2.
GRANT INSERT, UPDATE ON "job_runs" TO "heat_operator";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "job_locks" TO "heat_operator";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "operator_alerts" TO "heat_operator";
