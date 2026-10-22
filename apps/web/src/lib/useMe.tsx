import type { Me } from "@vc/shared";
import { createContext, useContext } from "react";

export const MeContext = createContext<Me | null>(null);
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("not signed in");
  return me;
}
