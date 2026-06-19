export type GeoblockResult = {
  blocked: boolean;
  reason?: string;
};

declare global {
  interface Window {
    __SIEGE_GEOBLOCK__?: () => Promise<GeoblockResult> | GeoblockResult;
  }
}

export async function checkGeoblock(): Promise<GeoblockResult> {
  if (typeof window.__SIEGE_GEOBLOCK__ === "function") {
    return window.__SIEGE_GEOBLOCK__();
  }

  const blockedRegions = (import.meta.env.VITE_GEOBLOCKED_TIMEZONES ?? "")
    .split(",")
    .map((zone: string) => zone.trim())
    .filter(Boolean);

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (blockedRegions.includes(timezone)) {
    return { blocked: true, reason: `Access restricted for ${timezone}.` };
  }

  return { blocked: false };
}
