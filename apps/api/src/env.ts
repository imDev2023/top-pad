import { Cluster } from "@top-pad/contract";

export type Bindings = {
  CLUSTER: string;
  WEB_ORIGIN: string;
  HYPERDRIVE: { connectionString: string };
};

export type Config = { cluster: Cluster; webOrigins: string[] };

/** The Worker's settings, checked: a misconfigured deploy fails on its first request, not halfway through one. */
export function config(env: Bindings): Config {
  return {
    cluster: Cluster.parse(env.CLUSTER),
    webOrigins: env.WEB_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean),
  };
}
