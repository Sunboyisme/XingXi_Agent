import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  AudioLines,
  Brain,
  Cable,
  Code2,
  Database,
  MessageCircle,
  Monitor,
  Palette,
  Search,
  Settings2,
  Sparkles,
  Wallet,
  Wrench,
  X,
} from "lucide-react";
import { GeneralSettings } from "./GeneralSettings";
import { DesktopSettings, SpeechConnection } from "./DesktopSettings";
import { ModelConnections, type ModelContextTarget } from "./ModelConnections";
import { type Settings, type Memory } from "@/lib/api";
import { Hint, Toast } from "./common";
import { WechatSection } from "./WechatSection";
import { ToolsSettings } from "./ToolsSettings";
import { MemoryPage } from "./MemoryPage";
import { EmbeddingSettings } from "./EmbeddingSettings";
import { SearchConnection } from "./SearchConnection";
import { ImageGenerationConnection } from "./ImageGenerationConnection";
import { SkillsSettings } from "./SkillsSettings";
import { DataSettings } from "./DataSettings";
import { ScriptRuntimeSettings } from "./ScriptRuntimeSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { UsageCosts } from "./UsageCosts";
import { errorMessage } from "@/lib/utils";
import "../styles/desktop-assistant.css";
import "../styles/settings-page.css";

const settingGroups = [
  {
    label: "个人偏好",
    items: [
      {
        id: "general",
        label: "常规",
        icon: Settings2,
        keywords: "开机自启 启动 聊天 输入建议",
      },
      {
        id: "appearance",
        label: "外观",
        icon: Palette,
        keywords: "主题 配色 浅色 深色 跟随系统",
      },
      {
        id: "desktop",
        label: "桌面助手",
        icon: Monitor,
        keywords: "截图 问答 桌宠 XiaoXi 划词 快捷键 右Alt 语音输入",
      },
    ],
  },
  {
    label: "模型与能力",
    items: [
      {
        id: "connections",
        label: "模型连接",
        icon: Cable,
        keywords: "LLM 服务商 API 密钥 对话 推理 上下文 思考 默认模型",
      },
      {
        id: "services",
        label: "能力连接",
        icon: AudioLines,
        keywords: "向量 嵌入 embedding 语音 识别 图片 生成 联网 搜索 Tavily",
      },
      {
        id: "tools",
        label: "工具",
        icon: Wrench,
        keywords: "内置 MCP 服务 JSON 导入 权限",
      },
      {
        id: "skills",
        label: "技能",
        icon: Sparkles,
        keywords: "skill ZIP 文件夹 导入 脚本 权限",
      },
      {
        id: "runtimes",
        label: "脚本环境",
        icon: Code2,
        keywords: "Python Node 解释器 路径 运行环境",
      },
    ],
  },
  {
    label: "集成",
    items: [
      {
        id: "wechat",
        label: "微信",
        icon: MessageCircle,
        keywords: "绑定 扫码 连接 提醒 通知 投递",
      },
    ],
  },
  {
    label: "数据与用量",
    items: [
      {
        id: "memories",
        label: "记忆",
        icon: Brain,
        keywords: "保存方式 自动 确认 检索 索引",
      },
      {
        id: "costs",
        label: "用量与费用",
        icon: Wallet,
        keywords: "token 模型 单价 价格 消费 调用 记录 统计",
      },
      {
        id: "data",
        label: "数据管理",
        icon: Database,
        keywords: "存储 目录 数据库 SQLite 备份 导入 导出 迁移",
      },
    ],
  },
] as const;

type SettingItem = (typeof settingGroups)[number]["items"][number];
const settingItems = settingGroups.flatMap<SettingItem>((group) => group.items);
export type SettingsTab = SettingItem["id"];
const persistentTabs: SettingsTab[] = [
  "connections",
  "services",
  "wechat",
  "tools",
  "memories",
];

export function SettingsPage({
  settings,
  onSaved,
  memories,
  refresh,
  tab,
  onTab,
  createRequested,
  contextTarget,
  onContextTargetHandled,
}: {
  settings: Settings;
  onSaved: (value: Settings) => void;
  memories: Memory[];
  refresh: () => Promise<void>;
  tab: SettingsTab;
  onTab: (value: SettingsTab) => void;
  createRequested?: number;
  contextTarget?: ModelContextTarget;
  onContextTargetHandled?: () => void;
}) {
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [openedTabs, setOpenedTabs] = useState(() => new Set([tab]));
  const content = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const keywords = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const groups = settingGroups
    .map((group) => ({
      label: group.label,
      items: group.items.filter((item) => {
        const text =
          `${group.label} ${item.label} ${item.keywords}`.toLocaleLowerCase();
        return keywords.every((word) => text.includes(word));
      }),
    }))
    .filter((group) => group.items.length > 0);
  const visibleItems = groups.flatMap((group) => group.items);
  const focusableTab = visibleItems.some((item) => item.id === tab)
    ? tab
    : visibleItems[0]?.id;
  const current = settingItems.find((item) => item.id === tab)!;

  useEffect(() => {
    setOpenedTabs((opened) =>
      opened.has(tab) ? opened : new Set([...opened, tab]),
    );
    if (content.current) content.current.scrollTop = 0;
  }, [tab]);

  useEffect(() => {
    if (tab !== "memories") return;
    let active = true;
    void refresh().catch((error) => {
      if (active) setError(errorMessage(error));
    });
    return () => {
      active = false;
    };
  }, [tab, refresh]);

  function navigateTabs(
    event: KeyboardEvent<HTMLButtonElement>,
    id: SettingsTab,
  ) {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = visibleItems.findIndex((item) => item.id === id);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? visibleItems.length - 1
          : (index +
              (event.key === "ArrowDown" ? 1 : visibleItems.length - 1)) %
            visibleItems.length;
    const value = visibleItems[next].id;
    onTab(value);
    document.getElementById(`settings-tab-${value}`)?.focus();
  }

  function renderPanel(value: SettingsTab) {
    switch (value) {
      case "general":
        return <GeneralSettings />;
      case "appearance":
        return <AppearanceSettings />;
      case "desktop":
        return (
          <section className="settings-group">
            <h2>桌面功能与快捷键</h2>
            <div className="settings-row-card">
              <DesktopSettings />
            </div>
          </section>
        );
      case "connections":
        return (
          <ModelConnections
            settings={settings}
            onSaved={onSaved}
            contextTarget={tab === "connections" ? contextTarget : undefined}
            onContextTargetHandled={onContextTargetHandled}
          />
        );
      case "services":
        return (
          <section className="settings-group">
            <h2>扩展能力</h2>
            <div className="connections-services">
              <EmbeddingSettings />
              <SpeechConnection />
              <ImageGenerationConnection />
              <SearchConnection settings={settings} onSaved={onSaved} />
            </div>
          </section>
        );
      case "wechat":
        return <WechatSection />;
      case "tools":
        return <ToolsSettings active={tab === "tools"} />;
      case "skills":
        return <SkillsSettings onRuntimes={() => onTab("runtimes")} />;
      case "runtimes":
        return <ScriptRuntimeSettings />;
      case "costs":
        return <UsageCosts />;
      case "data":
        return <DataSettings />;
      case "memories":
        return (
          <MemoryPage
            memories={memories}
            memoryMode={settings.memory_mode}
            refresh={refresh}
            createRequested={createRequested}
          />
        );
    }
  }

  return (
    <div className="settings-page">
      <aside className="settings-sidebar" aria-label="设置导航">
        <div className="settings-sidebar-header">
          <h2>设置</h2>
          <div className="settings-search">
            <Search size={17} aria-hidden="true" />
            <input
              ref={search}
              type="text"
              aria-label="搜索设置"
              placeholder="搜索设置"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery("");
                if (event.key === "Enter" && visibleItems[0]) {
                  event.preventDefault();
                  onTab(visibleItems[0].id);
                  document
                    .getElementById(`settings-tab-${visibleItems[0].id}`)
                    ?.focus();
                }
                if (event.key === "ArrowDown" && focusableTab) {
                  event.preventDefault();
                  document
                    .getElementById(`settings-tab-${focusableTab}`)
                    ?.focus();
                }
              }}
            />
            {query && (
              <Hint label="清空搜索">
                <button
                  type="button"
                  className="settings-search-clear"
                  aria-label="清空搜索"
                  onClick={() => {
                    setQuery("");
                    search.current?.focus();
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </Hint>
            )}
          </div>
        </div>
        <div
          className="settings-navigation"
          role="tablist"
          aria-label="设置分类"
          aria-orientation="vertical"
        >
          {groups.map((group) => (
            <div
              className="settings-nav-group"
              role="presentation"
              key={group.label}
            >
              <p aria-hidden="true">{group.label}</p>
              {group.items.map(({ id, label, icon: Icon }) => (
                <button
                  type="button"
                  key={id}
                  id={`settings-tab-${id}`}
                  role="tab"
                  aria-selected={tab === id}
                  aria-controls={`settings-panel-${id}`}
                  tabIndex={focusableTab === id ? 0 : -1}
                  onKeyDown={(event) => navigateTabs(event, id)}
                  onClick={() => onTab(id)}
                >
                  <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
                  <span>{label}</span>
                  {id === "memories" &&
                    memories.some((memory) => memory.state === "candidate") && (
                      <span
                        className="settings-memory-dot"
                        role="img"
                        aria-label="有待确认的记忆"
                      />
                    )}
                </button>
              ))}
            </div>
          ))}
          {visibleItems.length === 0 && (
            <p className="settings-search-empty" role="status">
              没有找到相关设置，试试其他关键词。
            </p>
          )}
        </div>
      </aside>
      <div className="settings-content" ref={content}>
        <div className="settings-content-inner">
          <header className="settings-content-heading">
            <h1 id="settings-category-heading">{current.label}</h1>
          </header>
          {error && (
            <Toast tone="error" message={error} onClose={() => setError("")} />
          )}
          {settingItems.map(({ id }) => (
            <div
              key={id}
              id={`settings-panel-${id}`}
              role="tabpanel"
              hidden={tab !== id}
              aria-labelledby={
                tab === id ? "settings-category-heading" : `settings-tab-${id}`
              }
              tabIndex={0}
              className="settings-panel"
            >
              {(tab === id ||
                (openedTabs.has(id) && persistentTabs.includes(id))) &&
                renderPanel(id)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
