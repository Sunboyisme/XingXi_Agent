import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsPage, type SettingsTab } from "./SettingsPage";
import { ToolsSettings } from "./ToolsSettings";
import type { Settings, Tool } from "@/lib/api";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
const settings: Settings = {
  model_url: "https://example.com/v1",
  model_name: "test-model",
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
      default_model: "test-model",
      key_configured: true,
      models: [
        {
          name: "test-model",
          vision_enabled: false,
          thinking_mode: "auto",
          thinking_control: "none",
        },
      ],
    },
  ],

  model_configured: true,
  search_configured: false,
};
const calculate: Tool = {
  id: "calculate",
  name: "计算器",
  description: "计算算式",
  enabled: true,
  available: true,
  source: "builtin",
  source_label: "内置工具",
  note: "内置工具",
  parameters: {},
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("cancelling search edits discards the draft without overwriting models or memory mode", async () => {
  apiMock.mockImplementation(async (path: string) =>
    path === "/settings"
      ? settings
      : path === "/wechat/status"
        ? { enabled: false, bound: false, deliveries: [] }
        : path === "/settings/image-generation"
          ? { enabled: false, url: "https://example.com/v1", model: "", size: "", response_format: "auto", key_configured: false }
          : [],
  );
  function Host() {
    const [tab, setTab] = React.useState<SettingsTab>("connections");
    return (
      <SettingsPage
        settings={settings}
        onSaved={vi.fn()}
        memories={[]}
        refresh={async () => {}}
        tab={tab}
        onTab={setTab}
      />
    );
  }
  render(<Host />);
  fireEvent.click(screen.getByRole("button", { name: "配置联网查资料" }));
  fireEvent.change(screen.getByLabelText("Tavily API 密钥"), {
    target: { value: "synthetic-search-draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  fireEvent.click(screen.getByRole("tab", { name: "工具" }));
  await screen.findByRole("button", { name: "添加 MCP" });
  fireEvent.click(screen.getByRole("tab", { name: "记忆" }));
  expect(screen.getByLabelText("记忆保存方式")).toBeDefined();
  fireEvent.click(screen.getByRole("tab", { name: "连接" }));
  fireEvent.click(screen.getByRole("button", { name: "配置联网查资料" }));
  expect(
    (screen.getByLabelText("Tavily API 密钥") as HTMLInputElement).value,
  ).toBe("");
  fireEvent.change(screen.getByLabelText("Tavily API 密钥"), {
    target: { value: "synthetic-new-search-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() =>
    expect(apiMock).toHaveBeenCalledWith(
      "/settings",
      "PUT",
      expect.objectContaining({
        providers: [],
        search_key: "synthetic-new-search-key",
      }),
    ),
  );
  const body = apiMock.mock.calls.find((x) => x[0] === "/settings")![2];
  expect(body).not.toHaveProperty("memory_mode");
});

test("JSON preview makes no requests and lists no secret values", async () => {
  apiMock.mockImplementation(async (path: string) =>
    path === "/tools" ? [calculate] : [],
  );
  render(<ToolsSettings active />);
  fireEvent.click(await screen.findByRole("button", { name: /内置工具/ }));
  await screen.findByText("计算器");
  fireEvent.click(screen.getByRole("button", { name: "导入 JSON" }));
  fireEvent.change(screen.getByLabelText("mcpServers JSON"), {
    target: {
      value: JSON.stringify({
        mcpServers: {
          demo: {
            url: "https://example.com/mcp",
            headers: { "X-Key": "synthetic-secret" },
          },
        },
      }),
    },
  });
  const before = apiMock.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "预览" }));
  expect(apiMock.mock.calls.length).toBe(before);
  expect(screen.getByLabelText("导入预览").textContent).not.toContain(
    "synthetic-secret",
  );
  fireEvent.click(screen.getByRole("button", { name: "确认导入" }));
  await waitFor(() =>
    expect(apiMock).toHaveBeenCalledWith(
      "/mcp/servers/import",
      "POST",
      expect.any(Object),
    ),
  );
  expect(apiMock.mock.calls.some((x) => String(x[0]).endsWith("/test"))).toBe(
    false,
  );
});

test("tool switch persists explicit disable", async () => {
  apiMock.mockImplementation(async (path: string) =>
    path === "/tools" ? [calculate] : [],
  );
  render(<ToolsSettings active />);
  fireEvent.click(await screen.findByRole("button", { name: /内置工具/ }));
  const toggle = await screen.findByRole("checkbox", {
    name: "启用 内置工具 · 计算器",
  });
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(apiMock).toHaveBeenCalledWith("/tools/calculate", "PATCH", {
      enabled: false,
    }),
  );
});

test.each(["synthetic-bailian-key", "Bearer synthetic-bailian-key"])(
  "Bailian search preset adds authentication and saves without connecting (%s)",
  async (key) => {
    apiMock.mockResolvedValue([]);
    render(<ToolsSettings active />);
    fireEvent.click(await screen.findByRole("button", { name: "添加 MCP" }));
    fireEvent.click(screen.getByRole("button", { name: "百炼联网搜索" }));
    expect(screen.getByLabelText("名称")).toHaveValue("百炼联网搜索");
    expect(screen.getByLabelText("服务地址")).toHaveValue(
      "https://dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp",
    );
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText("请填写百炼 API 密钥");
    expect(apiMock.mock.calls.some((call) => call[1] === "POST")).toBe(false);
    fireEvent.change(screen.getByLabelText("百炼 API 密钥"), {
      target: { value: key },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/mcp/servers",
        "POST",
        expect.objectContaining({
          transport: "streamable_http",
          enabled: false,
          url: "https://dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp",
          headers: { Authorization: "Bearer synthetic-bailian-key" },
        }),
      ),
    );
    expect(apiMock.mock.calls.some((call) => call[0].endsWith("/test"))).toBe(
      false,
    );
  },
);

test("saved environment references remain readable and can be hidden without resolving them", async () => {
  const server = {
    id: "env-ui",
    name: "引用测试",
    transport: "streamable_http",
    url: "https://example.invalid/mcp",
    command: "",
    args: [],
    cwd: "",
    headers: { Authorization: true },
    headers_templates: { Authorization: "Bearer ${MCP_QA_UI_KEY}" },
    env: {},
    enabled: false,
    status: "disabled",
    error: "",
    tool_count: 0,
    tested_at: null,
  };
  apiMock.mockImplementation(async (path: string) =>
    path === "/mcp/servers" ? [server] : [],
  );
  render(<ToolsSettings active />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const input = screen.getByLabelText("请求头值 1");
  expect(input).toHaveValue("Bearer ${MCP_QA_UI_KEY}");
  expect(input).toHaveAttribute("type", "text");
  fireEvent.click(screen.getByRole("button", { name: "隐藏请求头值 1" }));
  expect(input).toHaveAttribute("type", "password");
  fireEvent.click(screen.getByRole("button", { name: "显示请求头值 1" }));
  expect(input).toHaveAttribute("type", "text");
  fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
  await waitFor(() =>
    expect(apiMock).toHaveBeenCalledWith(
      "/mcp/servers/env-ui",
      "PUT",
      expect.objectContaining({
        headers: { Authorization: "Bearer ${MCP_QA_UI_KEY}" },
      }),
    ),
  );
  expect(apiMock.mock.calls.some((call) => call[0].endsWith("/test"))).toBe(
    false,
  );
});
