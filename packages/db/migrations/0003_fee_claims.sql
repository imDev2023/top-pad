CREATE TABLE "fee_claims" (
	"signature" text NOT NULL,
	"event_index" integer NOT NULL,
	"slot" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"pool" text NOT NULL,
	"mint" text NOT NULL,
	"creator" text NOT NULL,
	"creator_amount" bigint NOT NULL,
	"treasury_amount" bigint NOT NULL,
	CONSTRAINT "fee_claims_signature_event_index_pk" PRIMARY KEY("signature","event_index")
);
--> statement-breakpoint
CREATE TABLE "window_claims" (
	"pool" text PRIMARY KEY NOT NULL,
	"mint" text NOT NULL,
	"heat" boolean NOT NULL,
	"destination" text NOT NULL,
	"amount" bigint NOT NULL,
	"window_ended_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"signature" text NOT NULL,
	"slot" bigint NOT NULL,
	CONSTRAINT "window_claims_mint_unique" UNIQUE("mint")
);
--> statement-breakpoint
CREATE INDEX "fee_claims_creator_idx" ON "fee_claims" USING btree ("creator");--> statement-breakpoint
CREATE INDEX "fee_claims_mint_idx" ON "fee_claims" USING btree ("mint");