// The stand-in for X as a Worker: Heat's devnet API links it until Heat has its own X app (CLAUDE.md, "The build").
import { xStandIn } from "./handler";

type Env = {
  /** The API callbacks it redirects to, comma-separated. */
  CALLBACKS: string;
};

export default {
  fetch(request: Request, env: Env) {
    return xStandIn({ callbacks: env.CALLBACKS.split(",").map((c) => c.trim()) })(request);
  },
};
