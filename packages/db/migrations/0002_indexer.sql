CREATE TABLE "candles" (
	"mint" text NOT NULL,
	"seconds" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"open" numeric(38, 18) NOT NULL,
	"high" numeric(38, 18) NOT NULL,
	"low" numeric(38, 18) NOT NULL,
	"close" numeric(38, 18) NOT NULL,
	"open_key" numeric(30, 0) NOT NULL,
	"close_key" numeric(30, 0) NOT NULL,
	"volume_quote" numeric(30, 0) NOT NULL,
	"volume_base" numeric(30, 0) NOT NULL,
	"trades" integer NOT NULL,
	CONSTRAINT "candles_mint_seconds_starts_at_pk" PRIMARY KEY("mint","seconds","starts_at")
);
--> statement-breakpoint
CREATE TABLE "indexed_transactions" (
	"signature" text PRIMARY KEY NOT NULL,
	"slot" bigint NOT NULL,
	"block_index" integer,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pools" (
	"pool" text PRIMARY KEY NOT NULL,
	"mint" text NOT NULL,
	"config" text NOT NULL,
	"creator" text NOT NULL,
	"name" text NOT NULL,
	"ticker" text NOT NULL,
	"uri" text NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"created_signature" text NOT NULL,
	"created_slot" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"sqrt_price" numeric(40, 0) NOT NULL,
	"quote_reserve" bigint NOT NULL,
	"last_trade_key" numeric(30, 0),
	"holders" integer,
	"holders_counted_at" timestamp with time zone,
	CONSTRAINT "pools_mint_unique" UNIQUE("mint")
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"signature" text NOT NULL,
	"event_index" integer NOT NULL,
	"slot" bigint NOT NULL,
	"block_index" integer NOT NULL,
	"order_key" numeric(30, 0) NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"pool" text NOT NULL,
	"mint" text NOT NULL,
	"trader" text NOT NULL,
	"side" text NOT NULL,
	"quote_amount" bigint NOT NULL,
	"base_amount" bigint NOT NULL,
	"fee" bigint NOT NULL,
	"sqrt_price" numeric(40, 0) NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"quote_reserve" bigint NOT NULL,
	CONSTRAINT "trades_signature_event_index_pk" PRIMARY KEY("signature","event_index")
);
--> statement-breakpoint
ALTER TABLE "coins" ALTER COLUMN "image_uri" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "pools_created_idx" ON "pools" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "trades_mint_order_idx" ON "trades" USING btree ("mint","order_key");--> statement-breakpoint
CREATE INDEX "trades_trader_idx" ON "trades" USING btree ("trader");