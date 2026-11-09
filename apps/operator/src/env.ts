import type { Db } from "@top-pad/db";

/** The operator app's bindings (wrangler.jsonc). */
export type Bindings = {
  HYPERDRIVE: Hyperdrive;
  /** The API's blob bucket: Bundle Radar's evidence packs, and the audit log's daily exports. */
  BLOBS: R2Bucket;
  /** The cluster the deployment watches, for the header. */
  CLUSTER: string;
  /**
   * The audience tag of the Cloudflare Access application in front of this Worker. A request Access did not sign in for
   * this application is refused, so a missing tag refuses everything.
   */
  ACCESS_AUD?: string;
};

/** Who is acting: the operator Access signed in, by their email. */
export type Operator = { email: string };

export type AppEnv = { Bindings: Bindings; Variables: { db: Db; operator: Operator; nonce: string } };
