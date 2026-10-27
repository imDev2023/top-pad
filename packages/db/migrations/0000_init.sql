CREATE TABLE "indexer_cursors" (
	"account" text PRIMARY KEY NOT NULL,
	"signature" text,
	"slot" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_locks" (
	"job" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"summary" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "operator_alerts" (
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "operator_alerts_kind_subject_pk" PRIMARY KEY("kind","subject")
);
--> statement-breakpoint
CREATE INDEX "job_runs_job_started_idx" ON "job_runs" USING btree ("job","started_at");