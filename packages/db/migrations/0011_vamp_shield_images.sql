-- pgvector, for the image signatures' bit(256) and vector(512) columns and their HNSW indexes (spec 10.2); Neon, the
-- docker image and CI's all carry it.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "image_checks" (
	"sha256" text PRIMARY KEY NOT NULL,
	"pdq_dihedral" text[] NOT NULL,
	"pdq_quality" integer NOT NULL,
	"sscd" vector(512) NOT NULL,
	"answer_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protected_images" (
	"url" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sha256" text,
	"pdq" bit(256),
	"pdq_quality" integer,
	"sscd" vector(512),
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"computed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vamp_appeals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"ticker" text NOT NULL,
	"name" text NOT NULL,
	"image_sha256" text,
	"original" text,
	"message" text NOT NULL,
	"verdict" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vamp_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage" text NOT NULL,
	"creator_id" uuid,
	"launch_id" uuid,
	"ticker" text,
	"name" text,
	"image_sha256" text,
	"outcome" text NOT NULL,
	"matches" jsonb NOT NULL,
	"nearest" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "image_sha256" text;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "looks_like" jsonb;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "keeper_done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "protected_coins" ADD COLUMN "ticker_loose_dels" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "protected_coins" ADD COLUMN "name_loose_dels" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "protected_coins" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "protected_coins" ADD COLUMN "protected_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "protected_coins" ADD COLUMN "seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "protected_coins" ADD COLUMN "below_bar_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "protected_coins" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "vamp_appeals" ADD CONSTRAINT "vamp_appeals_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vamp_checks" ADD CONSTRAINT "vamp_checks_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "protected_images_status_idx" ON "protected_images" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "protected_images_pdq_idx" ON "protected_images" USING hnsw ("pdq" bit_hamming_ops);--> statement-breakpoint
CREATE INDEX "protected_images_sscd_idx" ON "protected_images" USING hnsw ("sscd" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "vamp_appeals_status_idx" ON "vamp_appeals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "vamp_appeals_creator_idx" ON "vamp_appeals" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "vamp_checks_at_idx" ON "vamp_checks" USING btree ("at");--> statement-breakpoint
CREATE INDEX "vamp_checks_outcome_idx" ON "vamp_checks" USING btree ("outcome","at");--> statement-breakpoint
CREATE INDEX "protected_coins_ticker_loose_dels" ON "protected_coins" USING gin ("ticker_loose_dels");--> statement-breakpoint
CREATE INDEX "protected_coins_name_loose_dels" ON "protected_coins" USING gin ("name_loose_dels");--> statement-breakpoint
CREATE INDEX "protected_coins_image_url" ON "protected_coins" USING btree ("image_url");--> statement-breakpoint
-- Fair Opens whose keeper finished before this column existed: their ticker was released, which marked it then.
UPDATE "launches" SET "keeper_done_at" = now() WHERE "mode" = 'fair_open' AND "status" = 'landed' AND "ticker_key" IS NULL;