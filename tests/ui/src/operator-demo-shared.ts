// What the operator app's demo seeding (operator-demo.ts, a script) and its spec (operator.e2e.ts) share.

/** The local Postgres server the demo database is made on. */
export const SERVER = process.env.OPERATOR_DEMO_SERVER ?? "postgres://toppad:toppad@127.0.0.1:5452/toppad";
export const NAME = "operator_demo";

/** The demo database, which the spec also writes to as the API would: a barred creator's appeal. */
export function operatorDemoUrl() {
  const url = new URL(SERVER);
  url.pathname = `/${NAME}`;
  return url.toString();
}

/** The operator who confirmed the seeded Bar: not the one `wrangler dev` signs in, who may therefore hear its appeal. */
export const FIRST_OPERATOR = "first-operator@heat.local";
