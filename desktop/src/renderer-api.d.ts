interface Window {
  deptriagem: {
    invoke<T>(channel: string, input?: object): Promise<{ok: true; data: T} | {ok: false; message: string}>;
    onMonitor(listener: (event: string, value: unknown) => void): void;
    onProgress(listener: (id: string, value: import("./progress").Progress) => void): void;
    onTheme(listener: (dark: boolean) => void): void;
  };
}
