const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * body.status extraction — bash: `json.load(...).get("status","unreachable")`
 * with any failure mapping to "unreachable".
 */
export const extractStatus = ({ bodyText }: { bodyText: string }): string => {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!isRecord(parsed)) return "unreachable";
    const status = parsed["status"];
    return status === undefined ? "unreachable" : String(status);
  } catch {
    return "unreachable";
  }
};

/**
 * JOB-725 regions rendering, ported from the bash inline python:
 * - per region: `region:verdict`
 * - for fail_slow | unknown verdicts append ` (reason)`
 * - regions object empty or missing -> "(no regions)"
 * - body missing / unparsable / wrong shape -> "(no body)"
 */
export const renderRegions = ({ bodyText }: { bodyText: string }): string => {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!isRecord(parsed)) return "(no body)";
    const regions = parsed["regions"] ?? {};
    if (!isRecord(regions)) return "(no body)";

    const parts: string[] = [];
    for (const [region, value] of Object.entries(regions)) {
      if (!isRecord(value)) return "(no body)";
      const verdict = String(value["verdict"]);
      if (verdict === "fail_slow" || verdict === "unknown") {
        parts.push(`${region}:${verdict} (${String(value["reason"])})`);
      } else {
        parts.push(`${region}:${verdict}`);
      }
    }
    return parts.length > 0 ? parts.join(", ") : "(no regions)";
  } catch {
    return "(no body)";
  }
};
