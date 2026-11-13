CREATE TABLE "coin_radar" (
	"mint" text PRIMARY KEY NOT NULL,
	"linked_wallets" text[] NOT NULL,
	"linked_coins" bigint NOT NULL,
	"early_buys" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coin_record_snapshots" (
	"day" text PRIMARY KEY NOT NULL,
	"coins" integer NOT NULL,
	"sha256" text NOT NULL,
	"signer" text NOT NULL,
	"signature" text NOT NULL,
	"storage_key" text NOT NULL,
	"chain_coins" integer,
	"mismatches" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "known_bots" (
	"wallet" text PRIMARY KEY NOT NULL,
	"early_launches" integer NOT NULL,
	"round_trips" integer NOT NULL,
	"evidence" jsonb NOT NULL,
	"listed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" text,
	"removed_note" text
);
--> statement-breakpoint
CREATE INDEX "known_bots_listed_idx" ON "known_bots" USING btree ("listed_at");--> statement-breakpoint
CREATE INDEX "trades_at_idx" ON "trades" USING btree ("at");--> statement-breakpoint
CREATE INDEX "trades_mint_at_idx" ON "trades" USING btree ("mint","at");--> statement-breakpoint
-- The operator app lists Heat's known-bot list and removes a wallet from it (spec 8, #57): `heat_operator` reads the list
-- and writes only the removal's columns, so it can never add a wallet or rewrite why one was listed.
GRANT SELECT ON "known_bots" TO "heat_operator";--> statement-breakpoint
GRANT UPDATE ("removed_at", "removed_by", "removed_note") ON "known_bots" TO "heat_operator";
