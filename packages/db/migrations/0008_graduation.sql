CREATE TABLE "graduations" (
	"mint" text PRIMARY KEY NOT NULL,
	"curve_pool" text NOT NULL,
	"pool" text NOT NULL,
	"config" text NOT NULL,
	"signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"graduated_at" timestamp with time zone NOT NULL,
	"sqrt_price" numeric(40, 0) NOT NULL,
	"creator_position" text NOT NULL,
	"creator_position_nft_mint" text NOT NULL,
	"creator_position_owner" text NOT NULL,
	"creator_liquidity" numeric(40, 0) NOT NULL,
	"heat_position" text NOT NULL,
	"heat_position_nft_mint" text NOT NULL,
	"heat_liquidity" numeric(40, 0) NOT NULL,
	"leftover_burnt" bigint,
	"leftover_signature" text,
	CONSTRAINT "graduations_curve_pool_unique" UNIQUE("curve_pool"),
	CONSTRAINT "graduations_pool_unique" UNIQUE("pool"),
	CONSTRAINT "graduations_signature_unique" UNIQUE("signature")
);
--> statement-breakpoint
CREATE TABLE "lp_fee_claims" (
	"signature" text NOT NULL,
	"event_index" integer NOT NULL,
	"slot" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"pool" text NOT NULL,
	"mint" text NOT NULL,
	"position" text NOT NULL,
	"owner" text NOT NULL,
	"quote_amount" bigint NOT NULL,
	"coin_amount" bigint NOT NULL,
	CONSTRAINT "lp_fee_claims_signature_event_index_pk" PRIMARY KEY("signature","event_index")
);
--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "curve_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "surplus_creator_amount" bigint;--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "surplus_treasury_amount" bigint;--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "surplus_signature" text;--> statement-breakpoint
CREATE INDEX "lp_fee_claims_owner_idx" ON "lp_fee_claims" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "lp_fee_claims_mint_idx" ON "lp_fee_claims" USING btree ("mint");