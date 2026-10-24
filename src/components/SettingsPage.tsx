import { useEffect, useState } from "react";
import { ModelConnections } from "./ModelConnections";
import { type Settings, type Memory } from "@/lib/api";
import { Toast } from "./common";
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

function ConnectionSettings({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (value: Settings) => void;
}) {
  return (
    <div className="connections-layout">
      <ModelConnections settings={settings} onSaved={onSaved} />
      <div className="connections-services">
        <EmbeddingSettings />
        <ImageGenerationConnection />
        <SearchConnection settings={settings} onSaved={onSaved} />
        <WechatSection compact />
      </div>
    </div>
  );
}

export type SettingsTab =
  | "connections"
  | "appearance"
  | "tools"
  | "skills"
  | "runtimes"
  | "memories"
  | "data"
  | "costs";
export function SettingsPage({
  settings,
  onSaved,
  memories,
  refresh,
  tab,
  onTab,
  createRequested,
}: {
  settings: Settings;
  onSaved: (value: Settings) => void;
  memories: Memory[];
  refresh: () => Promise<void>;
  tab: SettingsTab;
  onTab: (value: SettingsTab) => void;
  createRequested?: number;
}) {
  const [error, setError] = useState("");
  useEffect(() => {
    if (tab === "memories")
      void refresh().catch((error: Error) => setError(error.message));
  }, [tab, refresh]);
  return (
    <div className="settings-page page-content">
      <div className="page-heading">
        <h1>设置</h1>
      </div>
      {error && (
        <Toast tone="error" message={error} onClose={() => setError("")} />
      )}
      <div className="settings-tabs" role="tablist" aria-label="设置分类">
        {(
          [
            ["connections", "连接"],
            ["appearance", "外观"],
            ["tools", "工具"],
            ["skills", "技能"],
            ["runtimes", "脚本环境"],
            ["costs", "费用"],
            ["memories", "记忆"],
            ["data", "数据"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            id={`settings-tab-${value}`}
            role="tab"
            aria-selected={tab === value}
            aria-controls={`settings-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onKeyDown={(event) => {
              if (
                ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                const tabs: SettingsTab[] = [
                  "connections",
                  "appearance",
                  "tools",
                  "skills",
                  "runtimes",
                  "costs",
                  "memories",
                  "data",
                ];
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : (tabs.indexOf(tab) +
                          (event.key === "ArrowRight" ? 1 : tabs.length - 1)) %
                        tabs.length;
                onTab(tabs[next]);
                document.getElementById(`settings-tab-${tabs[next]}`)?.focus();
              }
            }}
            onClick={() => onTab(value)}
          >
            {label}
            {value === "memories" &&
              memories.some((x) => x.state === "candidate") && (
                <span className="candidate-dot" />
              )}
          </button>
        ))}
      </div>
      {tab === "appearance" && (
        <div
          id="settings-panel-appearance"
          role="tabpanel"
          aria-labelledby="settings-tab-appearance"
        >
          <AppearanceSettings />
        </div>
      )}
      {tab === "costs" && <div id="settings-panel-costs" role="tabpanel" aria-labelledby="settings-tab-costs"><UsageCosts /></div>}
      <div
        id="settings-panel-connections"
        role="tabpanel"
        aria-labelledby="settings-tab-connections"
        hidden={tab !== "connections"}
      >
        <ConnectionSettings settings={settings} onSaved={onSaved} />
      </div>
      <div
        id="settings-panel-tools"
        role="tabpanel"
        aria-labelledby="settings-tab-tools"
        hidden={tab !== "tools"}
      >
        <ToolsSettings active={tab === "tools"} />
      </div>
      {tab === "skills" && (
        <div
          id="settings-panel-skills"
          role="tabpanel"
          aria-labelledby="settings-tab-skills"
        >
          <SkillsSettings onRuntimes={() => onTab("runtimes")} />
        </div>
      )}
      {tab === "runtimes" && (
        <div
          id="settings-panel-runtimes"
          role="tabpanel"
          aria-labelledby="settings-tab-runtimes"
        >
          <ScriptRuntimeSettings />
        </div>
      )}
      <div
        id="settings-panel-data"
        role="tabpanel"
        aria-labelledby="settings-tab-data"
        hidden={tab !== "data"}
      >
        {tab === "data" && <DataSettings />}
      </div>
      <div
        id="settings-panel-memories"
        role="tabpanel"
        aria-labelledby="settings-tab-memories"
        hidden={tab !== "memories"}
      >
        <MemoryPage
          memories={memories}
          memoryMode={settings.memory_mode}
          refresh={refresh}
          createRequested={createRequested}
          embedded
        />
      </div>
    </div>
  );
}
