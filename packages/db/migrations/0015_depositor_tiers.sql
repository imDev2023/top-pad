CREATE TABLE "admission_reviews" (
	"launch" text NOT NULL,
	"wallet" text NOT NULL,
	"kind" text NOT NULL,
	"cluster" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "admission_reviews_launch_wallet_kind_pk" PRIMARY KEY("launch","wallet","kind")
);
--> statement-breakpoint
CREATE TABLE "linkage_hubs" (
	"address" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_fundings" (
	"wallet" text PRIMARY KEY NOT NULL,
	"funder" text,
	"signature" text,
	"amount" numeric(30, 0),
	"funded_at" timestamp with time zone,
	"history" integer NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_verifications" (
	"wallet" text PRIMARY KEY NOT NULL,
	"creator_id" uuid NOT NULL,
	"method" text NOT NULL,
	"message" text NOT NULL,
	"signature" text NOT NULL,
	"root" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_verifications" ADD CONSTRAINT "wallet_verifications_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admission_reviews_open_idx" ON "admission_reviews" USING btree ("created_at") WHERE "admission_reviews"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "wallet_verifications_creator_idx" ON "wallet_verifications" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "wallet_verifications_root_idx" ON "wallet_verifications" USING btree ("root");