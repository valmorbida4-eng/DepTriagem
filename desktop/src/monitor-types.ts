export const periods = ["hourly", "daily", "weekly", "monthly"] as const;
export type Period = typeof periods[number];
export interface MonitorConfig {
  id: string;
  enabled: boolean;
  login: string;
  scope: "all" | "selected";
  repos: string[];
  period: Period;
  start: string;
  refresh: boolean;
  refreshHours: number;
}
interface RepositoryResult {repo: string; report?: string; findings?: number; added?: number; partial?: boolean; error?: string}
export interface MonitorRun {
  id: string; started: string; finished?: string; repos: RepositoryResult[]; warnings: string[];
}
export interface MonitorStatus {
  config: MonitorConfig | null;
  next: string | null;
  running: boolean;
  runs: MonitorRun[];
}
