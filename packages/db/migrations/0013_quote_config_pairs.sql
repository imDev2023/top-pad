CREATE TABLE "quote_config_pairs" (
	"fair_open_config" text PRIMARY KEY NOT NULL,
	"instant_config" text NOT NULL,
	"quote_mint" text NOT NULL,
	"graduation_target" bigint NOT NULL,
	"step" bigint NOT NULL,
	"price" text,
	"origin" text NOT NULL,
	"made_at" timestamp with time zone DEFAULT now() NOT NULL,
	"named_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "quote_config_pairs_instant_config_unique" UNIQUE("instant_config")
);
--> statement-breakpoint
CREATE INDEX "quote_config_pairs_quote_idx" ON "quote_config_pairs" USING btree ("quote_mint","made_at");