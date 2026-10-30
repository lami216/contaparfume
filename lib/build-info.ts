import packageInfo from "../package.json" with { type: "json" };

export type BackupApplication = { packageName: string };
export type BackupBuild = { commit?: string; number?: string };

/** Next embeds these allowlisted CI identifiers; native startup needs no npm environment. */
export function backupBuildInfo() {
  const rawCommit = process.env.ALKARNA_BUILD_COMMIT ?? "";
  const rawNumber = process.env.ALKARNA_BUILD_NUMBER ?? "";
  const commit = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(rawCommit) ? rawCommit.toLowerCase() : undefined;
  const number = /^\d{1,12}$/.test(rawNumber) ? rawNumber : undefined;
  const build: BackupBuild | undefined = commit || number ? { ...(commit ? { commit } : {}), ...(number ? { number } : {}) } : undefined;
  return { appVersion: packageInfo.version, application: { packageName: packageInfo.name }, ...(build ? { build } : {}) };
}
