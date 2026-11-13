CREATE TABLE "bar_appeals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bar_id" uuid NOT NULL,
	"creator_id" uuid NOT NULL,
	"grounds" text NOT NULL,
	"statement" text NOT NULL,
	"evidence" text,
	"status" text DEFAULT 'open' NOT NULL,
	"filed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"decision_note" text
);
--> statement-breakpoint
CREATE TABLE "bar_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bar_id" uuid NOT NULL,
	"creator_id" uuid NOT NULL,
	"body" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"mint" text NOT NULL,
	"creator_id" uuid,
	"creator_wallet" text NOT NULL,
	"x_user_id" text,
	"confirmed_by" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"publish_at" timestamp with time zone NOT NULL,
	"note" text NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" text,
	"lifted_appeal" uuid,
	CONSTRAINT "bars_case_id_unique" UNIQUE("case_id")
);
--> statement-breakpoint
CREATE TABLE "x_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bar_id" uuid,
	"x_user_id" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"x_event_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "bundle_cases" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bundle_cases" ADD COLUMN "decided_by" text;--> statement-breakpoint
ALTER TABLE "bundle_cases" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "cancel_bar" uuid;--> statement-breakpoint
ALTER TABLE "bar_appeals" ADD CONSTRAINT "bar_appeals_bar_id_bars_id_fk" FOREIGN KEY ("bar_id") REFERENCES "public"."bars"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bar_appeals" ADD CONSTRAINT "bar_appeals_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bar_replies" ADD CONSTRAINT "bar_replies_bar_id_bars_id_fk" FOREIGN KEY ("bar_id") REFERENCES "public"."bars"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bar_replies" ADD CONSTRAINT "bar_replies_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bars" ADD CONSTRAINT "bars_case_id_bundle_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."bundle_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bars" ADD CONSTRAINT "bars_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_messages" ADD CONSTRAINT "x_messages_bar_id_bars_id_fk" FOREIGN KEY ("bar_id") REFERENCES "public"."bars"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bar_appeals_bar_idx" ON "bar_appeals" USING btree ("bar_id","filed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bar_appeals_one_open" ON "bar_appeals" USING btree ("bar_id") WHERE "bar_appeals"."status" = 'open';--> statement-breakpoint
CREATE INDEX "bar_replies_bar_idx" ON "bar_replies" USING btree ("bar_id","at");--> statement-breakpoint
CREATE INDEX "bars_creator_idx" ON "bars" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "bars_creator_wallet_idx" ON "bars" USING btree ("creator_wallet");--> statement-breakpoint
CREATE INDEX "bars_x_user_idx" ON "bars" USING btree ("x_user_id");--> statement-breakpoint
CREATE INDEX "bars_mint_idx" ON "bars" USING btree ("mint");--> statement-breakpoint
CREATE INDEX "x_messages_unsent_idx" ON "x_messages" USING btree ("created_at") WHERE "x_messages"."sent_at" is null;--> statement-breakpoint
-- The operator app confirms or dismisses a case, which bars the creator, cancels their Fair Opens not yet in their window
-- and owes them an X direct message, and hears the barred creator's appeals (spec 6.5, 6.6, #56). `heat_operator` gets
-- only those writes: it can never undo a decision, and a lifted Bar keeps its row.
GRANT SELECT ON "bars", "bar_appeals", "bar_replies", "x_messages" TO "heat_operator";--> statement-breakpoint
GRANT INSERT ON "bars", "x_messages" TO "heat_operator";--> statement-breakpoint
GRANT UPDATE ("status", "decided_at", "decided_by", "decision_note") ON "bundle_cases" TO "heat_operator";--> statement-breakpoint
GRANT UPDATE ("lifted_at", "lifted_by", "lifted_appeal") ON "bars" TO "heat_operator";--> statement-breakpoint
GRANT UPDATE ("status", "decided_at", "decided_by", "decision_note") ON "bar_appeals" TO "heat_operator";--> statement-breakpoint
GRANT UPDATE ("cancelled_at", "cancel_bar") ON "launches" TO "heat_operator";
