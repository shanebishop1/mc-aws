import { ServerState } from "@/lib/types";
import { describe, expect, it } from "vitest";

import { useButtonVisibility } from "./useButtonVisibility";

describe("useButtonVisibility", () => {
  it("hides hibernate action when server is stopped", () => {
    const stoppedWithVolume = useButtonVisibility(ServerState.Stopped, true);
    expect(stoppedWithVolume.showHibernate).toBe(false);

    const stoppedWithoutVolume = useButtonVisibility(ServerState.Stopped, false);
    expect(stoppedWithoutVolume.showHibernate).toBe(false);
  });

  it("shows hibernate action only when running and stable", () => {
    const running = useButtonVisibility(ServerState.Running, true, true);
    expect(running.showHibernate).toBe(true);

    const pending = useButtonVisibility(ServerState.Pending, true, true);
    expect(pending.showHibernate).toBe(false);
  });
});
