export type PathExists = (path: string) => boolean;

export function codexAppFeatureArgs(cwd: string, exists: PathExists): string[] {
  if (!exists(`${cwd}/.codex-apps-disabled`)) return [];
  return ['--disable', 'apps', '--disable', 'plugins'];
}
