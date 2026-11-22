export interface Progress {
  label: string;
  key?: string;
  completed?: number;
  total?: number;
  unit?: "bytes" | "steps" | "items" | "repos";
}
export type ReportProgress = (progress: Progress) => void;
