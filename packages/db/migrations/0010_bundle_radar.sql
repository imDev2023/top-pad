CREATE TABLE "bundle_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mint" text NOT NULL,
	"creator_wallet" text NOT NULL,
	"creator_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"linked_wallets" integer NOT NULL,
	"linked_coins" bigint NOT NULL,
	"supply" bigint NOT NULL,
	"evidence" jsonb NOT NULL,
	"evidence_key" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bundle_cases_mint_unique" UNIQUE("mint")
);
--> statement-breakpoint
CREATE TABLE "bundle_reviews" (
	"mint" text PRIMARY KEY NOT NULL,
	"outcome" text NOT NULL,
	"linked_wallets" integer NOT NULL,
	"linked_coins" bigint NOT NULL,
	"first_reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funding_scans" (
	"wallet" text PRIMARY KEY NOT NULL,
	"newest_signature" text,
	"newest_slot" bigint,
	"oldest_signature" text,
	"covers_from" timestamp with time zone NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jito_bundles" (
	"signature" text PRIMARY KEY NOT NULL,
	"bundle_id" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"signature" text NOT NULL,
	"ordinal" integer NOT NULL,
	"slot" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"destination" text NOT NULL,
	"asset" text NOT NULL,
	"amount" numeric(30, 0) NOT NULL,
	CONSTRAINT "transfers_signature_ordinal_pk" PRIMARY KEY("signature","ordinal")
);
--> statement-breakpoint
ALTER TABLE "indexed_transactions" ADD COLUMN "signers" text[];--> statement-breakpoint
ALTER TABLE "bundle_cases" ADD CONSTRAINT "bundle_cases_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bundle_cases_creator_wallet_idx" ON "bundle_cases" USING btree ("creator_wallet");--> statement-breakpoint
CREATE INDEX "bundle_cases_status_idx" ON "bundle_cases" USING btree ("status","opened_at");--> statement-breakpoint
CREATE INDEX "transfers_source_idx" ON "transfers" USING btree ("source","at");--> statement-breakpoint
CREATE INDEX "transfers_destination_idx" ON "transfers" USING btree ("destination","at");