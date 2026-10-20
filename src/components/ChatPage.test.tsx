import {
  act,
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { readEvents } from "@/lib/api";
import { ChatPage } from "./ChatPage";
import type { Settings } from "@/lib/api";

const settings: Settings = {
  model_name: "mock-test",
  model_url: "http://127.0.0.1:8877/v1",
  model_configured: true,
  search_configured: false,
  vision_enabled: false,
  timezone: "Asia/Shanghai",
  memory_mode: "auto",
  default_provider: "custom",
  provider_presets: [
    {
      id: "custom",
      label: "自定义兼容接口",
      model_url: "https://example.com/v1",
      models: [],
    },
  ],
  providers: [
    {
      id: "custom",
      provider_type: "custom",
      label: "自定义兼容接口",
      model_url: "https://example.com/v1",
      default_model: "mock-test",
      key_configured: true,
      models: [
        {
          name: "mock-test",
          vision_enabled: false,
          thinking_mode: "auto",
          thinking_control: "none",
        },
      ],
    },
  ],
};

const apiMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() =>
  vi.fn(() => Promise.reject(new Error("offline in tests"))),
);
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: apiMock,
  readEvents: vi.fn(),
  fetchApi: fetchMock,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

test("chat home has no character artwork and retains the editable composer", () => {
  apiMock.mockResolvedValue([]);
  render(
    <ChatPage
      conversationId={null}
      onConversation={vi.fn()}
      goals={[]}
      settings={settings}
      refresh={vi.fn()}
      onAction={vi.fn()}
      onPlan={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "今天想做点什么？" }),
  ).toBeTruthy();
  expect(screen.queryByRole("region", { name: "学习与提醒" })).toBeNull();
  const input = screen.getByLabelText("发送给XiaoXi的消息");
  fireEvent.change(input, { target: { value: "还没写完的消息" } });
  expect(screen.queryByRole("button", { name: "和XiaoXi打个招呼" })).toBeNull();
  expect(document.querySelector(".chat-main .bai-avatar")).toBeNull();
  expect((input as HTMLTextAreaElement).value).toBe("还没写完的消息");
});

test("home shortcuts replace the draft without sending it", async () => {
  apiMock.mockResolvedValue([]);
  render(
    <ChatPage
      conversationId={null}
      onConversation={vi.fn()}
      goals={[]}
      settings={settings}
      refresh={vi.fn()}
      onAction={vi.fn()}
      onPlan={vi.fn()}
    />,
  );
  const input = screen.getByLabelText(
    "发送给XiaoXi的消息",
  ) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "我已经写了一段" } });
  fireEvent.click(screen.getByRole("button", { name: "添加安排" }));
  expect(input.value).toBe(
    "帮我安排今天的时间。先问问我今天最想完成什么，再给出一个轻松可行的安排。",
  );
  expect(apiMock.mock.calls.every((call) => call.length === 1)).toBe(true);
});

test("a run completed before conversation handoff still shows its persisted answer", async () => {
  const user = {
    id: "user",
    role: "user",
    content: "请记住我的偏好",
    attachment_ids: [],
  };
  const assistant = {
    id: "assistant",
    role: "assistant",
    content: "记忆已保存，这是最终回答。",
    attachment_ids: [],
  };
  let messageReads = 0;
  apiMock.mockImplementation(async (path: string) => {
    if (path === "/conversations/fast/messages") {
      // The first read races with completion; the second sees the committed reply.
      return ++messageReads === 1 ? [user] : [user, assistant];
    }
    if (path === "/runs?conversation_id=fast")
      return [{ id: "finished", status: "completed" }];
    if (path === "/runs/finished/tools")
      return [
        {
          kind: "tool",
          data: { name: "保存记忆", result: { state: "confirmed" } },
        },
      ];
    throw new Error(`Unexpected API call: ${path}`);
  });
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(
    <ChatPage
      conversationId="fast"
      onConversation={vi.fn()}
      goals={[]}
      settings={{
        model_name: "mock-test",
        model_url: "http://127.0.0.1:8877/v1",
        model_configured: true,
        search_configured: false,
        vision_enabled: false,
        timezone: "Asia/Shanghai",
        memory_mode: "auto",
        default_provider: "custom",
        provider_presets: [
          {
            id: "custom",
            label: "自定义兼容接口",
            model_url: "https://example.com/v1",
            models: [],
          },
        ],
        providers: [
          {
            id: "custom",
            provider_type: "custom",
            label: "自定义兼容接口",
            model_url: "https://example.com/v1",
            default_model: "mock-test",
            key_configured: true,
            models: [
              {
                name: "mock-test",
                vision_enabled: false,
                thinking_mode: "auto",
                thinking_control: "none",
              },
            ],
          },
        ],
      }}
      refresh={refresh}
      onAction={vi.fn()}
      onPlan={vi.fn()}
    />,
  );
  expect(await screen.findByText(assistant.content)).toBeTruthy();
  expect(
    document.querySelector(".message.assistant .message-avatar"),
  ).not.toBeNull();
  expect(document.querySelector(".chat-main .bai-avatar")).not.toBeNull();
  expect(
    document
      .querySelector(".message.assistant .bai-avatar")
      ?.getAttribute("data-motion"),
  ).toBe("still");
  expect(refresh).toHaveBeenCalledOnce();
  expect(readEvents).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "复制回答" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "工具调用结果" })).toBeTruthy();
});

test("turn navigation scrolls to a selected question and resets for another chat", async () => {
  apiMock.mockImplementation(async (path: string) =>
    path === "/conversations/turns/messages"
      ? [
          { id: "u1", role: "user", content: "第一问", attachment_ids: [] },
          {
            id: "a1",
            role: "assistant",
            content: "第一答",
            attachment_ids: [],
          },
          { id: "u2", role: "user", content: "第二问", attachment_ids: [] },
        ]
      : [],
  );
  const props = {
    conversationId: "turns",
    onConversation: vi.fn(),
    goals: [],
    settings,
    refresh: vi.fn().mockResolvedValue(undefined),
    onAction: vi.fn(),
    onPlan: vi.fn(),
  };
  const view = render(<ChatPage {...props} />);
  const target = await screen.findByRole("button", { name: "第 2 轮：第二问" });
  const scrollTo = vi.fn();
  const scroll = document.querySelector(".chat-scroll")!;
  Object.defineProperty(scroll, "scrollTo", { value: scrollTo });
  scroll.scrollTop = 80;
  vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 40));
  vi.spyOn(
    screen.getByText("第二问").closest("article")!,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 350));
  fireEvent.click(target);
  expect(scrollTo).toHaveBeenCalledWith({ top: 366, behavior: "instant" });
  expect(target.getAttribute("aria-current")).toBe("step");
  expect(screen.getAllByRole("button", { name: /^第 \d 轮：/ })).toHaveLength(
    2,
  );
  view.rerender(<ChatPage {...props} conversationId={null} />);
  await waitFor(() =>
    expect(screen.queryByRole("navigation", { name: "对话定位" })).toBeNull(),
  );
});

test("new chats focus the composer and restore an unsent draft after remount", async () => {
  apiMock.mockResolvedValue([]);
  const first = render(
    <ChatPage
      conversationId={null}
      onConversation={vi.fn()}
      goals={[]}
      settings={settings}
      refresh={vi.fn()}
      onAction={vi.fn()}
      onPlan={vi.fn()}
    />,
  );
  const input = screen.getByLabelText(
    "发送给XiaoXi的消息",
  ) as HTMLTextAreaElement;
  await waitFor(() => expect(document.activeElement).toBe(input));
  fireEvent.change(input, { target: { value: "离开前还没写完的草稿" } });
  first.unmount();

  render(
    <ChatPage
      conversationId={null}
      onConversation={vi.fn()}
      goals={[]}
      settings={settings}
      refresh={vi.fn()}
      onAction={vi.fn()}
      onPlan={vi.fn()}
    />,
  );
  const restored = screen.getByLabelText(
    "发送给XiaoXi的消息",
  ) as HTMLTextAreaElement;
  expect(restored.value).toBe("离开前还没写完的草稿");
  await waitFor(() => expect(document.activeElement).toBe(restored));
});

test("restores draft text and attached images after leaving the chat page", async () => {
  apiMock.mockResolvedValue([]);
  localStorage.setItem(
    "bai-chat-draft:new",
    JSON.stringify({
      text: "带着图片的未发送草稿",
      images: [
        {
          id: "image-1",
          name: "cat.png",
          media_type: "image/png",
          width: 120,
          height: 120,
        },
      ],
    }),
  );
  render(
    <ChatPage
      conversationId={null}
      onConversation={vi.fn()}
      goals={[]}
      settings={settings}
      refresh={vi.fn()}
      onAction={vi.fn()}
      onPlan={vi.fn()}
    />,
  );
  const input = screen.getByLabelText(
    "发送给XiaoXi的消息",
  ) as HTMLTextAreaElement;
  expect(input.value).toBe("带着图片的未发送草稿");
  expect(await screen.findByText("cat.png")).toBeTruthy();
  await waitFor(() =>
    expect(
      document.querySelector(".composer-attachments .attachment-draft"),
    ).not.toBeNull(),
  );
});

test("keeps an animated status line while a reply is still streaming", async () => {
  let emit: ((event: any) => void) | undefined;
  apiMock.mockImplementation(async (path: string, method = "GET") => {
    if (path === "/conversations/slow/messages" && method === "POST")
      return { id: "run-slow", status: "queued" };
    if (path === "/conversations/slow/messages") return [];
    if (path === "/runs?conversation_id=slow") return [];
    return [];
  });
  vi.mocked(readEvents).mockImplementation((_id, onEvent) => {
    emit = onEvent;
    return new Promise<never>(() => {});
  });
  render(
    <ChatPage
      conversationId="slow"
      onConversation={vi.fn()}
      goals={[]}
      settings={settings}
      refresh={vi.fn().mockResolvedValue(undefined)}
      onAction={vi.fn()}
      onPlan={vi.fn()}
    />,
  );
  const input = screen.getByLabelText("发送给XiaoXi的消息");
  await waitFor(() => expect(document.activeElement).toBe(input));
  fireEvent.change(input, { target: { value: "生成一张海报" } });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await waitFor(() => expect(emit).toBeTruthy());
  act(() => emit?.({ kind: "delta", data: { text: "我先整理一下" } }));
  expect(await screen.findByText("我先整理一下")).toBeTruthy();
  expect(screen.getByText("正在努力工作")).toBeTruthy();
  expect(document.querySelectorAll(".thinking-dots > i")).toHaveLength(3);
});
