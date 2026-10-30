export type Runtime = Record<
  string,
  { path: string; resolved: string; available: boolean }
>;

export type RuntimeEditorState = {
  runtimes: Runtime;
  paths: Record<string, string>;
  dirty: boolean;
  busy: boolean;
  error: string;
  notice: string;
  loaded: boolean;
};

export const emptyRuntimeEditor: RuntimeEditorState = {
  runtimes: {},
  paths: {},
  dirty: false,
  busy: false,
  error: "",
  notice: "",
  loaded: false,
};
